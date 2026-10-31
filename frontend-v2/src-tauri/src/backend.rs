//! `backend-rs.exe` lifecycle: spawn, health-poll, kill.
//!
//! # Which backend this spawns
//!
//! The **Rust** backend, not v1's `backend.exe`. v1 is still the stable
//! fallback and may be installed on the same machine, so this shell talks
//! only to `backend-rs.exe` and only through v2's own state files
//! (`config-rs.json`, `port-rs.txt`). Spawning v1 from here would give the
//! user two inference stacks fighting over one port.
//!
//! # Why the timeout stays generous
//!
//! A native binary starts in well under a second, so the ~23 s PyInstaller
//! cold start that forced v1's 120 s budget is gone. The budget is still not
//! tight: `backend-rs` may download the 90 MB embedding model on a first run,
//! and Defender scans a freshly written exe. A shipped v1 bug was a 30 s
//! budget reporting "Backend failed to start" against a backend that came up
//! fine seconds later - do not re-tighten this to a value that only works on
//! a warm cache.

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::config::AppConfig;
use crate::paths;

/// Ports the backend may bind, in fallback order. Mirrors
/// `PORT_FALLBACK_CHAIN` in `backend-rs/src/paths.rs`, and the `connect-src` list in
/// `tauri.conf.json` — all three must agree.
pub const PORT_FALLBACK_CHAIN: [u32; 4] = [8000, 8001, 8002, 8003];

pub struct BackendState {
    child: Mutex<Option<Child>>,
    /// The port the backend actually answered on.
    port: Mutex<u32>,
    online: Mutex<bool>,
}

impl Default for BackendState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            port: Mutex::new(PORT_FALLBACK_CHAIN[0]),
            online: Mutex::new(false),
        }
    }
}

impl BackendState {
    pub fn port(&self) -> u32 {
        self.port.lock().map(|p| *p).unwrap_or(PORT_FALLBACK_CHAIN[0])
    }

    pub fn is_online(&self) -> bool {
        self.online.lock().map(|o| *o).unwrap_or(false)
    }

    fn set_port(&self, port: u32) {
        if let Ok(mut p) = self.port.lock() {
            *p = port;
        }
    }

    fn set_online(&self, value: bool) {
        if let Ok(mut o) = self.online.lock() {
            *o = value;
        }
    }
}

fn backend_exe_path() -> PathBuf {
    if paths::is_packaged() {
        // Bundled as a resource next to the executable.
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_default()
            .join("backend-rs.exe")
    } else {
        // Dev: cargo's own output in `backend-rs/target`. Release first -
        // a debug build of the embedder is slow enough to look broken.
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .map(PathBuf::from)
            .unwrap_or_default();
        let target = repo.join("backend-rs").join("target");
        let release = target.join("release").join("backend-rs.exe");
        if release.is_file() {
            release
        } else {
            target.join("debug").join("backend-rs.exe")
        }
    }
}

/// The port written by the backend once it has bound. The backend falls
/// through 8000→8003, so this file — not the configured value — is the truth.
fn read_port_override() -> Option<u32> {
    std::fs::read_to_string(paths::appdata_port_file())
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .filter(|p| *p > 0)
}

/// One `GET /health` against loopback. `true` only on HTTP 200.
pub fn ping_health(port: u32, timeout: Duration) -> bool {
    let url = format!("http://127.0.0.1:{port}/health");
    ureq::builder()
        .timeout(timeout)
        .build()
        .get(&url)
        .call()
        .map(|r| r.status() == 200)
        .unwrap_or(false)
}

#[cfg(windows)]
fn spawn_hidden(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    // Without CREATE_NO_WINDOW the child flashes a console window on
    // every launch.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn spawn_hidden(_cmd: &mut Command) {}

/// Spawn the bundled backend. Production only — dev never spawns.
fn spawn_backend(state: &BackendState) -> Result<(), String> {
    let exe = backend_exe_path();
    if !exe.exists() {
        return Err(format!("backend-rs.exe not found at {}", exe.display()));
    }
    paths::log_line(&format!("spawning backend: {}", exe.display()));

    // Pin the Hugging Face cache to AppData\rag\models BEFORE the backend
    // boots, so sentence-transformers never writes to %USERPROFILE%\.cache —
    // which is invisible to the uninstaller and would re-download for every
    // Windows user account on the machine.
    let hf_home = paths::appdata_rag_models();
    let mut cmd = Command::new(&exe);
    cmd.current_dir(exe.parent().unwrap_or(std::path::Path::new(".")))
        .env("HF_HOME", &hf_home)
        .env("TRANSFORMERS_CACHE", &hf_home)
        .env("SENTENCE_TRANSFORMERS_HOME", &hf_home)
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    spawn_hidden(&mut cmd);

    match cmd.spawn() {
        Ok(child) => {
            if let Ok(mut slot) = state.child.lock() {
                *slot = Some(child);
            }
            Ok(())
        }
        Err(e) => {
            paths::log_line(&format!("backend spawn error: {e}"));
            Err(format!("Could not start the backend: {e}"))
        }
    }
}

/// Poll `/health` until it answers or the budget expires. Re-reads
/// `port.txt` on every attempt, because the backend may have fallen through
/// to a different port than the configured one.
fn wait_for_backend(state: &BackendState, budget: Duration) -> Option<u32> {
    let start = Instant::now();
    let mut port = state.port();
    let mut attempt = 0u32;

    while start.elapsed() < budget {
        if let Some(override_port) = read_port_override() {
            port = override_port;
        }
        if ping_health(port, Duration::from_secs(5)) {
            paths::log_line(&format!(
                "backend healthy on :{port} after {}s",
                start.elapsed().as_secs()
            ));
            state.set_port(port);
            return Some(port);
        }

        attempt += 1;
        // A onefile cold start is tens of seconds of silence. Log every ~10 s
        // so a slow boot is distinguishable from a hung one in frontend.log.
        if attempt % 5 == 0 {
            paths::log_line(&format!(
                "waiting for backend on :{port} ({}s elapsed)",
                start.elapsed().as_secs()
            ));
        }

        // The spawned process died outright — no point burning the budget.
        if paths::is_packaged() {
            let dead = state
                .child
                .lock()
                .map(|mut guard| match guard.as_mut() {
                    Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                    None => true,
                })
                .unwrap_or(false);
            if dead {
                paths::log_line("backend process exited during startup; abandoning wait");
                return None;
            }
        }

        std::thread::sleep(Duration::from_secs(2));
    }
    None
}

/// Bring the backend up, or confirm it already is. Returns the live port.
pub fn ensure_running(state: &BackendState, cfg: &AppConfig) -> Result<u32, String> {
    // `cfg.backend_port` is u16 (a port is), while the host carries ports as
    // u32 throughout; widening is lossless.
    let start_port = read_port_override().unwrap_or(u32::from(cfg.backend_port));
    state.set_port(start_port);

    // Already running — short-circuit. In dev this is the normal path.
    if ping_health(start_port, Duration::from_secs(5)) {
        paths::log_line(&format!("backend already healthy on :{start_port}"));
        state.set_online(true);
        return Ok(start_port);
    }

    if paths::is_packaged() {
        spawn_backend(state)?;
        // 120 s — see the module docstring. Do not tighten.
        match wait_for_backend(state, Duration::from_secs(120)) {
            Some(port) => {
                state.set_online(true);
                Ok(port)
            }
            None => {
                state.set_online(false);
                Err(format!(
                    "The backend did not start. Check the log at {}",
                    paths::appdata_logs().join("backend.log").display()
                ))
            }
        }
    } else {
        // Dev: the developer runs `cargo run --release` in another terminal,
        // so a rebuild does not require restarting the shell. Never spawn in dev.
        paths::log_line("dev mode: not spawning backend; polling /health");
        match wait_for_backend(state, Duration::from_secs(30)) {
            Some(port) => {
                state.set_online(true);
                Ok(port)
            }
            None => {
                state.set_online(false);
                // `cargo run --release` rather than a bare `cargo run`: the
                // debug embedder is slow enough that a first query looks
                // hung. It resolves the port through the 8000-8003 fallback
                // chain and writes port-rs.txt, which is what this reads.
                Err("Backend not running. Start it with: cd backend-rs; cargo run --release".into())
            }
        }
    }
}

/// Stop the backend we spawned. A backend started by the developer is left
/// alone — we only ever kill a child we own.
pub fn kill(state: &BackendState) {
    if let Ok(mut slot) = state.child.lock() {
        if let Some(child) = slot.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *slot = None;
    }
    state.set_online(false);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The port chain, the CSP and the save validator must agree, or the app
    /// bricks itself in a way no in-app screen can undo.
    ///
    /// The renderer reaches the backend over `fetch`, which the Tauri CSP
    /// gates. If `save_config` accepts a port the CSP does not allow, the
    /// backend starts and answers while the renderer is blocked from ever
    /// reaching it -- including the Settings panel that would put the port
    /// back. The only recovery is hand-editing config.json.
    ///
    /// This reads the real `tauri.conf.json` rather than a copy of the list,
    /// because a copy drifts exactly like the thing it is checking.
    #[test]
    fn the_csp_allows_every_port_in_the_fallback_chain_and_no_others() {
        let conf = include_str!("../tauri.conf.json");
        let parsed: serde_json::Value =
            serde_json::from_str(conf).expect("tauri.conf.json parses");
        let csp = parsed["app"]["security"]["csp"]["connect-src"]
            .as_str()
            .expect("connect-src is a string");

        for port in PORT_FALLBACK_CHAIN {
            assert!(
                csp.contains(&format!("http://127.0.0.1:{port}")),
                "the CSP does not allow port {port}, which the fallback chain uses"
            );
        }

        // And nothing outside it: an extra allowed port would let the
        // validator be loosened later without this test noticing.
        let allowed: Vec<u32> = csp
            .split_whitespace()
            .filter_map(|s| s.strip_prefix("http://127.0.0.1:"))
            .filter_map(|s| s.parse().ok())
            .collect();
        assert_eq!(
            allowed,
            PORT_FALLBACK_CHAIN.to_vec(),
            "the CSP's localhost ports and PORT_FALLBACK_CHAIN have drifted"
        );
    }
}
