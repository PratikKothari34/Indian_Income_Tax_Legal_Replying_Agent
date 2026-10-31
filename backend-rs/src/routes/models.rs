//! `GET /models` — what the user can pick in the model dropdown.
//!
//! v1 asked Ollama for its pulled models. llama.cpp has no registry: a
//! server loads one `.gguf` and serves it. So "available models" becomes
//! "`.gguf` files the user has", discovered from the configured model
//! paths and the directories they sit in.
//!
//! The response keeps v1's shape — `{primary, fallback, models: [...]}`
//! with `{name, size, modified_at}` per entry — because the frontend's
//! dropdown is built from those field names.
//!
//! One deliberate difference: **this never returns 503.** v1 did, when
//! Ollama was down, which made the dropdown empty and unexplained. Here
//! the model list comes from the filesystem and is useful even with no
//! server running; server reachability is `/health`'s job.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use axum::{extract::State, Json};
use serde::Serialize;

use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct ModelEntry {
    pub name: String,
    pub size: u64,
    pub modified_at: String,
    /// Absolute path, for `POST /generate`'s `model` override.
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct ModelsResponse {
    pub primary: String,
    pub fallback: String,
    pub models: Vec<ModelEntry>,
    /// Model loaded by the running server, if any. With no configured
    /// path this is the only model actually usable.
    pub loaded: Option<String>,
}

/// How deep to look under a model directory. Model collections nest one or
/// two levels (`models/Qwen/...`); deeper is somebody's whole drive.
const SCAN_DEPTH: usize = 2;

pub async fn get_models(State(state): State<AppState>) -> Json<ModelsResponse> {
    let cfg = state.config().await;
    let health = state.llama.health(&cfg).await;

    // Deduplicate on the absolute path: the primary and fallback usually
    // live in the same folder, so a naive scan lists every model twice.
    let mut found: BTreeMap<PathBuf, ModelEntry> = BTreeMap::new();

    for configured in [&cfg.llama_model_path, &cfg.llama_fallback_model_path] {
        let configured = configured.trim();
        if configured.is_empty() {
            continue;
        }
        let path = Path::new(configured);
        // The configured file is listed even if it no longer exists, so the
        // dropdown shows the user's own selection rather than silently
        // dropping it. `/health` is what reports it missing.
        if let Some(entry) = describe(path) {
            found.insert(path.to_path_buf(), entry);
        }
        if let Some(dir) = path.parent() {
            scan(dir, 0, &mut found);
        }
    }

    let mut models: Vec<ModelEntry> = found.into_values().collect();
    // Newest first: the model a user just downloaded is the one they want.
    models.sort_by(|a, b| b.modified_at.cmp(&a.modified_at).then(a.name.cmp(&b.name)));

    Json(ModelsResponse {
        primary: label(&cfg.llama_model_path),
        fallback: label(&cfg.llama_fallback_model_path),
        models,
        loaded: health.loaded_model,
    })
}

fn label(path: &str) -> String {
    let path = path.trim();
    if path.is_empty() {
        return String::new();
    }
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

fn describe(path: &Path) -> Option<ModelEntry> {
    let name = path.file_stem().and_then(|s| s.to_str())?.to_string();
    let (size, modified_at) = match std::fs::metadata(path) {
        Ok(m) => {
            let ts = m
                .modified()
                .ok()
                .map(chrono::DateTime::<chrono::Utc>::from)
                .map(|t| t.format("%Y-%m-%dT%H:%M:%S+00:00").to_string())
                .unwrap_or_default();
            (m.len(), ts)
        }
        // A configured-but-missing model: listed with zeroes rather than
        // hidden, so the UI can show the selection it was given.
        Err(_) => (0, String::new()),
    };
    Some(ModelEntry {
        name,
        size,
        modified_at,
        path: path.display().to_string(),
    })
}

fn scan(dir: &Path, depth: usize, out: &mut BTreeMap<PathBuf, ModelEntry>) {
    if depth > SCAN_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => scan(&path, depth + 1, out),
            Ok(ft) if ft.is_file() => {
                let is_gguf = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("gguf"))
                    .unwrap_or(false);
                // A split model ("...-00001-of-00003.gguf") is loaded by
                // naming its first shard, so the later shards are not
                // separately selectable and would clutter the dropdown.
                let is_later_shard = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| {
                        let lower = s.to_lowercase();
                        lower.contains("-of-") && !lower.contains("00001-of-")
                    })
                    .unwrap_or(false);
                if is_gguf && !is_later_shard {
                    if let Some(e) = describe(&path) {
                        out.insert(path, e);
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gguf_files_are_discovered_beside_the_configured_model() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.gguf"), b"x").unwrap();
        std::fs::write(dir.path().join("b.gguf"), b"yy").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"not a model").unwrap();

        let mut out = BTreeMap::new();
        scan(dir.path(), 0, &mut out);
        let names: Vec<&str> = out.values().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a"), "{names:?}");
        assert!(names.contains(&"b"), "{names:?}");
        assert!(!names.contains(&"notes"), "{names:?}");
    }

    #[test]
    fn later_shards_of_a_split_model_are_hidden() {
        // Only the first shard is loadable; listing the rest offers the
        // user three entries that each fail.
        let dir = tempfile::tempdir().unwrap();
        for n in 1..=3 {
            std::fs::write(
                dir.path().join(format!("big-0000{n}-of-00003.gguf")),
                b"x",
            )
            .unwrap();
        }
        let mut out = BTreeMap::new();
        scan(dir.path(), 0, &mut out);
        assert_eq!(out.len(), 1);
        assert!(out.values().next().unwrap().name.contains("00001-of-"));
    }

    #[test]
    fn a_configured_but_missing_model_is_still_listed() {
        // Dropping it would silently blank the user's own selection.
        let entry = describe(Path::new(r"C:\gone\qwen.gguf")).unwrap();
        assert_eq!(entry.name, "qwen");
        assert_eq!(entry.size, 0);
    }

    #[test]
    fn the_scan_depth_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let deep = dir.path().join("a").join("b").join("c").join("d");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("hidden.gguf"), b"x").unwrap();
        let mut out = BTreeMap::new();
        scan(dir.path(), 0, &mut out);
        assert!(out.is_empty(), "must not walk the whole drive: {out:?}");
    }
}
