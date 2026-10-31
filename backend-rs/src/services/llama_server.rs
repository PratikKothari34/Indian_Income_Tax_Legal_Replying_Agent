//! Optional supervision of a local `llama-server` process.
//!
//! v1 talked to Ollama, which runs as a Windows service and manages its own
//! lifetime. llama.cpp ships a plain executable, so somebody has to start
//! it. Who that is depends on the install, and guessing wrong is worse than
//! doing nothing:
//!
//! * A user who already runs `llama-server` by hand, or from a batch file,
//!   or as a service shared with other apps, must not get a second instance
//!   fighting for the same port and the same GPU memory.
//! * A user who just wants the app to work should not have to run anything.
//!
//! So this is **opt-in through one config key**. `llama_server_path` empty
//! (the default) means "assume a server is already running; never spawn".
//! Set it, and this module starts the server, waits for it to answer, and
//! kills it on shutdown.
//!
//! No model is ever downloaded here. `llama_model_path` points at a `.gguf`
//! the user already has; a missing file is reported, not fetched.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::config::AppConfig;
use crate::services::llama_client::LlamaClient;

/// How long to wait for a freshly spawned server to answer `/health`.
///
/// Loading a 14B Q4 model off a cold disk into VRAM is tens of seconds; on
/// a spinning disk with a large context it can exceed a minute. Timing out
/// early kills a server that was about to become ready, which looks to the
/// user exactly like a crash.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(180);
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Grace period between asking the child to stop and killing it.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

fn child_slot() -> &'static Mutex<Option<Child>> {
    static SLOT: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

#[derive(Debug)]
pub enum SpawnOutcome {
    /// `llama_server_path` is empty: the user manages the server.
    NotConfigured,
    /// A server was already answering on the configured port, so nothing
    /// was spawned. This is the normal case on a second backend start.
    AlreadyRunning,
    /// Spawned and answering.
    Started { pid: u32 },
    /// Could not start. The string is user-facing: it goes into
    /// `/health`'s error field and the Settings panel shows it.
    Failed(String),
}

impl SpawnOutcome {
    pub fn error(&self) -> Option<&str> {
        match self {
            Self::Failed(msg) => Some(msg),
            _ => None,
        }
    }
}

/// Build the argument list for `llama-server`.
///
/// Exposed for testing, because getting these flags wrong is silent: a
/// server started without `--port` listens on 8080 regardless of config,
/// and every request then 404s against a server that looks healthy.
pub fn build_args(cfg: &AppConfig) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    if !cfg.llama_model_path.trim().is_empty() {
        args.push("-m".into());
        args.push(cfg.llama_model_path.trim().into());
    }
    args.push("--host".into());
    // Bind loopback only. The host config key can carry a full URL for a
    // remote server, which is meaningless for a process we spawn locally,
    // so the bind address is fixed rather than derived from it.
    args.push("127.0.0.1".into());
    args.push("--port".into());
    args.push(cfg.llama_port.to_string());
    args.push("-c".into());
    args.push(cfg.llama_ctx_size.to_string());
    // 999 offloads every layer it can; llama.cpp clamps to the layer count
    // and falls back to CPU for whatever does not fit, so an over-large
    // value is the right default rather than an error.
    args.push("-ngl".into());
    args.push(cfg.llama_gpu_layers.to_string());
    // One slot. The backend serialises inference anyway (a legal reply takes
    // minutes and the UI drives one at a time); more slots just split the
    // KV cache and shrink the usable context per request.
    args.push("--parallel".into());
    args.push("1".into());
    args
}

/// Check whether something already answers on the configured llama port.
async fn server_is_up(cfg: &AppConfig, client: &LlamaClient) -> bool {
    client.health(cfg).await.server_running
}

/// Is the port held by a program that is not llama-server?
///
/// Spawning into such a port produces a child that dies on bind, which the
/// user sees as a crash loop with no cause named. Checking first turns that
/// into one sentence naming the real problem.
async fn port_held_by_other(cfg: &AppConfig, client: &LlamaClient) -> bool {
    client.health(cfg).await.port_occupied_by_other
}

/// Start `llama-server` if configured and not already running.
pub async fn ensure_running(cfg: &AppConfig) -> SpawnOutcome {
    let exe = cfg.llama_server_path.trim();
    let client = LlamaClient::new();

    if exe.is_empty() {
        if server_is_up(cfg, &client).await {
            tracing::info!(
                "llama-server is answering at {} and llama_server_path is unset - \
                 using the existing server",
                cfg.llama_base_url()
            );
        } else {
            tracing::warn!(
                "no llama-server at {} and llama_server_path is unset - \
                 inference will fail until a server is started or the path is configured",
                cfg.llama_base_url()
            );
        }
        return SpawnOutcome::NotConfigured;
    }

    // Probe before spawning. Two servers on one port means the second dies
    // with a bind error and the user sees a crash loop for a working setup.
    if server_is_up(cfg, &client).await {
        tracing::info!("llama-server is already running at {}", cfg.llama_base_url());
        return SpawnOutcome::AlreadyRunning;
    }

    // Occupied by something else: do not spawn. The child would lose the
    // bind and exit, and the user would be told the model server crashed
    // when in fact the port was never available. Observed on Windows with
    // ApplicationWebServer.exe, a service, holding llama.cpp's default 8080.
    if port_held_by_other(cfg, &client).await {
        let msg = format!(
            "Port {} is held by another program, so llama-server cannot start.              Change llama_port in Settings to a free port.",
            cfg.llama_port
        );
        tracing::error!("{msg}");
        return SpawnOutcome::Failed(msg);
    }

    let exe_path = PathBuf::from(exe);
    if !exe_path.is_file() {
        let msg = format!("llama_server_path does not point at a file: {exe}");
        tracing::error!("{msg}");
        return SpawnOutcome::Failed(msg);
    }
    let model = cfg.llama_model_path.trim();
    if !model.is_empty() && !Path::new(model).is_file() {
        let msg = format!("llama_model_path does not point at a file: {model}");
        tracing::error!("{msg}");
        return SpawnOutcome::Failed(msg);
    }

    let args = build_args(cfg);
    tracing::info!("starting llama-server: {} {}", exe, args.join(" "));

    let mut command = Command::new(&exe_path);
    command
        .args(&args)
        // The server's own log goes nowhere: it is noisy, and inheriting
        // the handles keeps the parent's console alive after the backend
        // exits on Windows. Failures surface through the health probe.
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        // Kill the server if this process dies without a clean shutdown.
        // Without it a crashed backend leaves a model resident in VRAM.
        .kill_on_drop(true);
    if let Some(dir) = exe_path.parent() {
        // llama-server loads its CUDA DLLs from alongside the executable.
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        // `creation_flags` is tokio's own inherent method on its Command,
        // so the std CommandExt trait is not needed here.
        // CREATE_NO_WINDOW: without it a packaged (windowed) build pops a
        // console window on every start.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("could not start llama-server: {e}");
            tracing::error!("{msg}");
            return SpawnOutcome::Failed(msg);
        }
    };
    let pid = child.id().unwrap_or(0);
    *child_slot().lock().await = Some(child);

    // Wait for it to answer rather than sleeping a fixed interval: load
    // time varies by an order of magnitude with model size and disk.
    let deadline = tokio::time::Instant::now() + STARTUP_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        // A child that has already exited will never answer; fail now with
        // its status instead of waiting out the full timeout.
        if let Some(child) = child_slot().lock().await.as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                let msg = format!("llama-server exited during startup with {status}");
                tracing::error!("{msg}");
                return SpawnOutcome::Failed(msg);
            }
        }
        if server_is_up(cfg, &client).await {
            tracing::info!("llama-server is ready (pid {pid}) at {}", cfg.llama_base_url());
            return SpawnOutcome::Started { pid };
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }

    let msg = format!(
        "llama-server did not answer within {}s of starting",
        STARTUP_TIMEOUT.as_secs()
    );
    tracing::error!("{msg}");
    stop().await;
    SpawnOutcome::Failed(msg)
}

/// Stop a server this process started. A no-op for an external one.
pub async fn stop() {
    let Some(mut child) = child_slot().lock().await.take() else {
        return;
    };
    let pid = child.id().unwrap_or(0);
    tracing::info!("stopping llama-server (pid {pid})");

    // There is no portable graceful signal: Windows has no SIGTERM, and
    // llama-server has no shutdown endpoint. Kill, then reap, so the
    // process does not linger as a zombie holding VRAM.
    if let Err(e) = child.start_kill() {
        tracing::warn!("could not signal llama-server (pid {pid}): {e}");
    }
    match tokio::time::timeout(SHUTDOWN_GRACE, child.wait()).await {
        Ok(Ok(status)) => tracing::info!("llama-server exited with {status}"),
        Ok(Err(e)) => tracing::warn!("could not reap llama-server: {e}"),
        Err(_) => tracing::warn!("llama-server did not exit within the grace period"),
    }
}

/// True when the running server was started by this process.
pub async fn is_managed() -> bool {
    child_slot().lock().await.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> AppConfig {
        AppConfig {
            llama_port: 9123,
            llama_ctx_size: 4096,
            llama_gpu_layers: 35,
            llama_model_path: r"D:\models\qwen.gguf".into(),
            ..Default::default()
        }
    }

    #[test]
    fn the_port_is_always_passed() {
        // Omitting --port silently leaves the server on 8080, and every
        // request then fails against a server that reports healthy.
        let args = build_args(&cfg());
        let i = args.iter().position(|a| a == "--port").expect("--port");
        assert_eq!(args[i + 1], "9123");
    }

    #[test]
    fn the_model_path_and_context_are_passed() {
        let args = build_args(&cfg());
        let m = args.iter().position(|a| a == "-m").expect("-m");
        assert_eq!(args[m + 1], r"D:\models\qwen.gguf");
        let c = args.iter().position(|a| a == "-c").expect("-c");
        assert_eq!(args[c + 1], "4096");
        let n = args.iter().position(|a| a == "-ngl").expect("-ngl");
        assert_eq!(args[n + 1], "35");
    }

    #[test]
    fn a_blank_model_path_omits_the_flag() {
        // The server may have been pointed at a model on its own command
        // line; passing an empty -m would make it refuse to start.
        let mut c = cfg();
        c.llama_model_path = "   ".into();
        let args = build_args(&c);
        assert!(!args.iter().any(|a| a == "-m"));
    }

    #[test]
    fn the_bind_address_is_loopback_even_for_a_remote_host_setting() {
        let mut c = cfg();
        c.llama_host = "http://192.168.1.50:8080".into();
        let args = build_args(&c);
        let h = args.iter().position(|a| a == "--host").expect("--host");
        assert_eq!(args[h + 1], "127.0.0.1");
    }

    #[tokio::test]
    async fn an_unset_path_never_spawns() {
        let mut c = cfg();
        c.llama_server_path = String::new();
        // Port 9123 has nothing on it, so this also covers the
        // "configured but no server" warning path.
        assert!(matches!(
            ensure_running(&c).await,
            SpawnOutcome::NotConfigured
        ));
        assert!(!is_managed().await);
    }

    #[tokio::test]
    async fn a_missing_executable_is_reported_not_panicked() {
        let mut c = cfg();
        c.llama_server_path = r"C:\definitely\not\here\llama-server.exe".into();
        let outcome = ensure_running(&c).await;
        let msg = outcome.error().expect("a failure message");
        assert!(msg.contains("llama_server_path"), "{msg}");
        assert!(!is_managed().await);
    }
}
