//! ITaxReplyAgent backend, v2 — Rust + llama.cpp.
//!
//! A **separate** backend. The Python `backend/` is untouched and remains
//! the stable one; this crate owns its own state files
//! (`config-rs.json`, `port-rs.txt`, `rag/vectors-rs/`,
//! `sync_status-rs.json`) so both can be installed side by side and
//! either can be run without disturbing the other.
//!
//! Two things are shared on purpose:
//!
//! * `auth_token.txt` — the frontend holds one token and must be able to
//!   drive either backend.
//! * `rag/models/` — the 90 MB embedding model should not download twice.
//!
//! v1's `config.json` is **read, never written**, so a first run inherits
//! the user's existing settings (notably their Indian Kanoon token)
//! without ever putting a value back into the file v1 depends on.
//!
//! Inference is llama.cpp through `llama-server`'s OpenAI-compatible
//! HTTP API rather than FFI against libllama: no C++ linkage, no bindgen,
//! and CUDA stays the user's install choice instead of becoming a
//! compile-time property of this binary.

pub mod config;
pub mod middleware;
pub mod paths;
pub mod routes;
pub mod services;
pub mod state;

use std::time::Duration;

use axum::routing::{get, post};
use axum::Router;
use tower_http::trace::TraceLayer;

use crate::state::AppState;

/// Build the application router.
///
/// Route paths are v1's, exactly. Renaming one ships a backend an
/// installed frontend cannot call, and the two update independently.
/// Additions are safe; `/rag/query` is the only one.
pub fn router(state: AppState) -> Router {
    // `/generate` gets the body cap; nothing else needs it, and applying
    // it globally would buffer multipart uploads twice.
    // `/save-docx` shares the cap: its body is a whole reply, so it is the
    // same order of size as a generate request and needs the same bound.
    let generate = Router::new()
        .route("/generate", post(routes::generate::generate_reply))
        .route("/save-docx", post(routes::generate::save_docx))
        .layer(axum::middleware::from_fn(middleware::generate_body_cap));

    Router::new()
        .route("/", get(routes::health::root))
        .route("/health", get(routes::health::get_health))
        .route("/models", get(routes::models::get_models))
        .route("/upload", post(routes::upload::upload_document))
        .merge(generate)
        .route("/rag/status", get(routes::rag::rag_status))
        .route("/rag/sync", post(routes::rag::rag_sync_trigger))
        .route("/rag/documents", get(routes::rag::rag_documents))
        .route("/rag/reindex", post(routes::rag::rag_reindex))
        .route("/rag/docs-folder", get(routes::rag::rag_docs_folder))
        .route("/rag/query", get(routes::rag::rag_query))
        // Order matters: the guard runs before any handler, and CORS runs
        // outermost so a rejected request still carries the headers a
        // browser needs to report the failure rather than a network error.
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::local_origin_guard,
        ))
        .layer(middleware::cors_layer())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Is something already listening on `port`?
fn port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
}

/// Resolve a listening port: the configured one, else the fallback chain.
///
/// The frontend does not guess — it reads `port-rs.txt`, which is written
/// after this resolves. v1 learned the hard way that a hard-coded 8000
/// fails silently on a machine where something else holds it.
pub fn resolve_port(preferred: u16) -> anyhow::Result<u16> {
    if !port_in_use(preferred) {
        return Ok(preferred);
    }
    tracing::warn!("port {preferred} is in use; trying the fallback chain");
    for port in paths::PORT_FALLBACK_CHAIN {
        if port != preferred && !port_in_use(port) {
            tracing::info!("falling back to port {port}");
            return Ok(port);
        }
    }
    anyhow::bail!(
        "every port in {:?} is already in use - is another copy of the backend running?",
        paths::PORT_FALLBACK_CHAIN
    )
}

/// Install tracing: a rolling file in `logs/` plus stderr.
///
/// Returns the guard; **dropping it loses buffered log lines**, so the
/// caller must hold it for the process lifetime. A crash with its own
/// cause unflushed is the one log line that always matters.
pub fn init_tracing() -> tracing_appender::non_blocking::WorkerGuard {
    use tracing_subscriber::prelude::*;

    let dir = paths::logs_dir();
    let _ = std::fs::create_dir_all(&dir);
    let file = tracing_appender::rolling::daily(&dir, "backend-rs.log");
    let (writer, guard) = tracing_appender::non_blocking(file);

    let filter = tracing_subscriber::EnvFilter::try_from_env("ITAX_LOG")
        // `hyper` and `h2` at debug drown everything else in frame noise.
        .unwrap_or_else(|_| "info,hyper=warn,h2=warn,reqwest=warn".into());

    tracing_subscriber::registry()
        .with(filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer)
                .with_ansi(false),
        )
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .init();

    guard
}

/// How long to wait for in-flight requests on shutdown.
///
/// Short on purpose: a `/generate` can legitimately run for minutes, and
/// the user who closed the window is not waiting for it. The reply is
/// lost either way; what must not be lost is the session file, and
/// `session_store` writes temp-then-rename so a kill mid-write cannot
/// truncate it.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// Resolves when the process should stop: Ctrl-C, or SIGTERM on unix.
pub async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => tracing::info!("shutdown: interrupt received"),
        _ = terminate => tracing::info!("shutdown: terminate received"),
    }
}
