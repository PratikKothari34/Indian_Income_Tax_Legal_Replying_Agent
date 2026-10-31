//! `GET /health` — is inference reachable, and with which model.
//!
//! The frontend shell polls this during startup to decide when the backend
//! is usable, so it must answer fast and must never block on a model load.
//! That is why `llama_client` keeps a separate 10-second probe deadline:
//! the 900-second chat deadline here would hang the splash screen.
//!
//! The response shape is a **superset** of v1's, not a replacement.
//! `ollama_running`, `primary_available`, `fallback_available` and `error`
//! are all still present, because an installed frontend reads those field
//! names and renaming them breaks a client that updates independently of
//! the backend. `ollama_running` now means "an inference server is
//! answering" — llama.cpp, in this backend.

use axum::{extract::State, Json};
use serde::Serialize;

use crate::services::llama_server;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    /// Kept under v1's name: an installed frontend reads this key.
    pub ollama_running: bool,
    pub primary_available: bool,
    pub fallback_available: bool,
    pub error: Option<String>,

    // v2 additions. New fields are safe; renames are not.
    pub engine: &'static str,
    pub base_url: String,
    pub loaded_model: Option<String>,
    pub primary_model: String,
    pub fallback_model: String,
    /// True when this backend started the inference server itself.
    pub server_managed: bool,
}

pub async fn get_health(State(state): State<AppState>) -> Json<HealthResponse> {
    let cfg = state.config().await;
    let health = state.llama.health(&cfg).await;

    // "Available" here means the configured path points at a file that
    // exists. A server loads one model at a time, so the question v1 asked
    // of Ollama's model list ("have you pulled it?") maps to "is the gguf
    // on disk?" — which is what the user can actually act on.
    let primary_available = model_present(&cfg.llama_model_path);
    let fallback_available = model_present(&cfg.llama_fallback_model_path);

    // Degraded, not failed: a server that is up with a model loaded from
    // its own command line has no configured path and is still perfectly
    // usable, so a loaded model counts as availability.
    let usable =
        health.server_running && (primary_available || fallback_available || health.loaded_model.is_some());

    Json(HealthResponse {
        status: if usable { "ok" } else { "degraded" },
        ollama_running: health.server_running,
        primary_available,
        fallback_available,
        error: health.error,
        engine: "llama.cpp",
        base_url: health.base_url,
        loaded_model: health.loaded_model,
        primary_model: model_label(&cfg.llama_model_path),
        fallback_model: model_label(&cfg.llama_fallback_model_path),
        server_managed: llama_server::is_managed().await,
    })
}

fn model_present(path: &str) -> bool {
    let path = path.trim();
    !path.is_empty() && std::path::Path::new(path).is_file()
}

/// A model's display name: the file stem, which is what a user recognises.
/// A full `.gguf` path in a dropdown is unreadable.
fn model_label(path: &str) -> String {
    let path = path.trim();
    if path.is_empty() {
        return String::new();
    }
    std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

/// `GET /` — discovery. Same shape as v1.
pub async fn root() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "name": "Indian Income Tax Legal Replying Agent",
        "status": "running",
        "backend": "rust/llama.cpp",
        "endpoints": ["/health", "/models", "/upload", "/generate", "/rag"],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_model_label_is_the_file_stem() {
        assert_eq!(
            model_label(r"D:\models\Qwen2.5-14B-Instruct-Q4_K_M.gguf"),
            "Qwen2.5-14B-Instruct-Q4_K_M"
        );
        assert_eq!(model_label("  "), "");
    }

    #[test]
    fn a_blank_path_is_never_reported_as_available() {
        assert!(!model_present(""));
        assert!(!model_present("   "));
        assert!(!model_present(r"C:\nope\missing.gguf"));
    }

    #[test]
    fn the_v1_field_names_survive_serialisation() {
        // An installed frontend reads these exact keys. A rename ships a
        // backend that reports healthy to a UI that shows it as down.
        let body = serde_json::to_string(&HealthResponse {
            status: "ok",
            ollama_running: true,
            primary_available: true,
            fallback_available: false,
            error: None,
            engine: "llama.cpp",
            base_url: "http://127.0.0.1:8080".into(),
            loaded_model: None,
            primary_model: "m".into(),
            fallback_model: String::new(),
            server_managed: false,
        })
        .unwrap();
        for key in [
            "status",
            "ollama_running",
            "primary_available",
            "fallback_available",
            "error",
        ] {
            assert!(body.contains(&format!("\"{key}\"")), "missing {key}: {body}");
        }
    }
}
