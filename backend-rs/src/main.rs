//! Process entry point.
//!
//! Startup order is load-bearing, and each step is here rather than in a
//! helper so the order is readable:
//!
//! 1. **Directories and the HF cache before anything touches them** —
//!    `fastembed` reads `HF_HOME` at first use, and if that happens before
//!    `configure_hf_cache`, a 90 MB model lands in the user's home
//!    directory instead of the app's own data folder.
//! 2. **Tracing before any fallible step**, so a failure has somewhere to
//!    be recorded. A packaged build has no console to print to.
//! 3. **Port resolution before `write_port`** — the frontend reads that
//!    file to find the backend and does not guess.
//! 4. **llama-server supervision after the port is written**, because it
//!    can take up to 180 s to load a model and the shell should already be
//!    able to see the backend and poll `/health` while that happens.
//!
//! The server binds 127.0.0.1 only. Binding 0.0.0.0 would put a local
//! inference endpoint with no authentication on the user's network.

use std::net::SocketAddr;

use itax_backend_rs::{
    config, init_tracing, paths, resolve_port, router, services, shutdown_signal, state::AppState,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Before tracing: the log directory is one of these.
    paths::ensure_dirs()?;
    // Before fastembed is ever touched, or the model downloads to the
    // wrong place.
    paths::configure_hf_cache();

    // Held for the process lifetime; dropping it loses buffered lines.
    let _log_guard = init_tracing();

    tracing::info!(
        "ITaxReplyAgent backend v{} (rust/llama.cpp) starting",
        env!("CARGO_PKG_VERSION")
    );
    tracing::info!("base dir: {}", paths::base_dir().display());

    let cfg = config::load();
    tracing::info!(
        "inference: {} (ctx {}, {} gpu layer(s))",
        cfg.llama_base_url(),
        cfg.llama_ctx_size,
        cfg.llama_gpu_layers
    );

    // Per-install bearer token, shared with v1 so one frontend can drive
    // either backend. Generated on first run; never logged.
    let auth_token = paths::ensure_auth_token()?;

    let port = resolve_port(cfg.backend_port)?;
    if port != cfg.backend_port {
        // Persist the fallback so the next launch starts where it ended
        // up, matching v1's behaviour.
        let mut updated = cfg.clone();
        updated.backend_port = port;
        if let Err(e) = config::save(&updated) {
            tracing::warn!("could not persist the fallback port: {e}");
        }
    }
    paths::write_port(port)?;

    let state = AppState::new(cfg.clone(), auth_token);

    // Optional, opt-in through `llama_server_path`. An empty path means
    // "a server is already running, or the user starts it themselves" —
    // spawning a second instance on one port would break a working setup.
    match services::llama_server::ensure_running(&cfg).await {
        services::llama_server::SpawnOutcome::NotConfigured => {
            tracing::info!(
                "llama_server_path is unset; assuming an external llama-server at {}",
                cfg.llama_base_url()
            );
        }
        services::llama_server::SpawnOutcome::AlreadyRunning => {
            tracing::info!("an inference server is already answering; not spawning one");
        }
        services::llama_server::SpawnOutcome::Started { pid } => {
            tracing::info!("started llama-server (pid {pid})");
        }
        services::llama_server::SpawnOutcome::Failed(e) => {
            // Not fatal. Every non-inference route still works, and
            // `/health` reports the failure so the UI can show it.
            tracing::error!("could not start llama-server: {e}");
        }
    }

    // One-minute ticker driving the cron schedule. An unparseable
    // expression degrades to the noon default rather than taking the
    // process down at startup, which is how v1 could be bricked from the
    // Settings panel.
    let scheduler = services::rag_scheduler::spawn(&cfg);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{addr}");

    let result = axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await;

    tracing::info!("shutting down");
    scheduler.abort();
    // Only stops a server this process started. An external one is the
    // user's, and killing it would take down whatever else is using it.
    services::llama_server::stop().await;

    result?;
    Ok(())
}
