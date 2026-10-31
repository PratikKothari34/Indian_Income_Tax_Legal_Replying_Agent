//! `config-rs.json` load/save. Mirrors `backend/paths.py::DEFAULT_CONFIG`,
//! with the Ollama keys replaced by llama.cpp equivalents.
//!
//! # The three-copy rule still applies
//!
//! v1's `DEFAULT_CONFIG` lives in `backend/paths.py` AND
//! `frontend/electron/main.ts`, with a third copy in
//! `installer/installer.nsh`. This file adds a fourth for the v2 stack. Any
//! key that exists in both stacks must be changed in every copy — whichever
//! process writes first decides what a fresh install gets.
//!
//! # Secrets
//!
//! `indiankanoon_token` is blank in source and must stay blank. A real token
//! committed here is public permanently. It is injected at runtime only, and
//! masked whenever it crosses a process boundary.

use std::fs;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::paths;

/// Default llama-server port. llama.cpp's own default is 8080, which collides
/// with nothing here (the backend itself starts at 8000).
pub const DEFAULT_LLAMA_PORT: u16 = 8080;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    // --- inference (llama.cpp) ---
    /// Host of a running `llama-server`.
    #[serde(default = "default_llama_host")]
    pub llama_host: String,
    #[serde(default = "default_llama_port")]
    pub llama_port: u16,
    /// Absolute path to `llama-server.exe`.
    ///
    /// Empty means "assume it is already running at llama_host:llama_port and
    /// do not try to spawn it". Managing the process is opt-in because a
    /// user's own llama-server may already be serving other apps.
    #[serde(default)]
    pub llama_server_path: String,
    /// Absolute path to the primary GGUF model file.
    #[serde(default)]
    pub llama_model_path: String,
    /// Optional second GGUF, used when the primary fails or a notice is
    /// complex enough to want a reasoning model.
    #[serde(default)]
    pub llama_fallback_model_path: String,
    /// Context window passed to llama-server as `-c`.
    #[serde(default = "default_ctx_size")]
    pub llama_ctx_size: u32,
    /// Layers offloaded to GPU (`-ngl`). 999 means "all that fit"; the user
    /// has a CUDA build, so this is the fast default.
    #[serde(default = "default_gpu_layers")]
    pub llama_gpu_layers: u32,

    // --- server ---
    #[serde(default = "default_backend_port")]
    pub backend_port: u16,

    // --- RAG ---
    #[serde(default = "default_sync_schedule")]
    pub rag_sync_schedule: String,
    /// SECURITY: intentionally blank in source. Never commit a populated value.
    #[serde(default)]
    pub indiankanoon_token: String,
    #[serde(default)]
    pub incometax_pdf_scraper_enabled: bool,

    // --- desktop (owned by the shell, persisted here) ---
    #[serde(default)]
    pub run_at_startup: bool,
    #[serde(default = "default_true")]
    pub system_tray: bool,
    #[serde(default = "default_true")]
    pub keep_awake: bool,
}

fn default_llama_host() -> String {
    "127.0.0.1".into()
}
fn default_llama_port() -> u16 {
    DEFAULT_LLAMA_PORT
}
fn default_ctx_size() -> u32 {
    8192
}
fn default_gpu_layers() -> u32 {
    999
}
fn default_backend_port() -> u16 {
    8000
}
fn default_sync_schedule() -> String {
    // Noon daily — the canonical default across README, installer and shell.
    "0 12 * * *".into()
}
fn default_true() -> bool {
    true
}

/// Common install locations for `llama-server`, most specific first.
///
/// Auto-discovery rather than a hardcoded path: the config file is written
/// once on first run, so a path baked into the binary would be wrong for
/// every machine but the one it was built on. An empty result is fine -
/// `llama_server_path` stays blank, which means "do not supervise", and the
/// user can point Settings at their own build.
///
/// Note the CMake layout puts the real code in `llama-server-impl.dll`
/// beside the executable, so whatever is found here must be launched with
/// its own directory as the working directory or the CUDA backend will not
/// load. `llama_server::ensure_running` does that.
fn discover_llama_server() -> String {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("llama.cpp/build/bin/Release/llama-server.exe"));
        candidates.push(home.join("llama.cpp/install/bin/llama-server.exe"));
    }
    for root in [r"C:\tools\llama.cpp", r"C:\llama.cpp", r"C:\Program Files\llama.cpp"] {
        let root = std::path::Path::new(root);
        candidates.push(root.join("install/bin/llama-server.exe"));
        candidates.push(root.join("build/bin/Release/llama-server.exe"));
        candidates.push(root.join("llama-server.exe"));
    }
    for c in candidates {
        if c.is_file() {
            return c.display().to_string();
        }
    }
    String::new()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            llama_host: default_llama_host(),
            llama_port: default_llama_port(),
            llama_server_path: discover_llama_server(),
            llama_model_path: String::new(),
            llama_fallback_model_path: String::new(),
            llama_ctx_size: default_ctx_size(),
            llama_gpu_layers: default_gpu_layers(),
            backend_port: default_backend_port(),
            rag_sync_schedule: default_sync_schedule(),
            indiankanoon_token: String::new(),
            incometax_pdf_scraper_enabled: false,
            run_at_startup: false,
            system_tray: true,
            keep_awake: true,
        }
    }
}

impl AppConfig {
    pub fn llama_base_url(&self) -> String {
        let host = self.llama_host.trim();
        if host.contains("://") {
            host.trim_end_matches('/').to_string()
        } else {
            let host = if host.is_empty() { "127.0.0.1" } else { host };
            format!("http://{host}:{}", self.llama_port)
        }
    }
}

/// Load v2's config, merging over defaults so an older file gains new keys.
///
/// On first run, settings shared with v1 are inherited from `config.json`
/// (read-only) so the user does not retype them. The Indian Kanoon token is
/// inherited too — it is the same credential for the same API — but v2 never
/// writes back to that file.
pub fn load() -> AppConfig {
    if let Ok(text) = fs::read_to_string(paths::config_path()) {
        if let Ok(cfg) = serde_json::from_str::<AppConfig>(&text) {
            return cfg;
        }
        tracing::warn!("config-rs.json is unreadable; falling back to defaults");
    }
    inherit_from_v1().unwrap_or_default()
}

/// Read the v1 config for the keys both stacks share. Never writes.
fn inherit_from_v1() -> Option<AppConfig> {
    let text = fs::read_to_string(paths::legacy_config_path()).ok()?;
    let v1: serde_json::Value = serde_json::from_str(&text).ok()?;
    let mut cfg = AppConfig::default();
    if let Some(s) = v1.get("rag_sync_schedule").and_then(|v| v.as_str()) {
        if is_valid_cron(s) {
            cfg.rag_sync_schedule = s.to_string();
        }
    }
    if let Some(s) = v1.get("indiankanoon_token").and_then(|v| v.as_str()) {
        cfg.indiankanoon_token = s.to_string();
    }
    if let Some(b) = v1
        .get("incometax_pdf_scraper_enabled")
        .and_then(|v| v.as_bool())
    {
        cfg.incometax_pdf_scraper_enabled = b;
    }
    let as_bool = |key: &str| v1.get(key).and_then(|v| v.as_bool());
    if let Some(b) = as_bool("run_at_startup") {
        cfg.run_at_startup = b;
    }
    if let Some(b) = as_bool("system_tray") {
        cfg.system_tray = b;
    }
    if let Some(b) = as_bool("keep_awake") {
        cfg.keep_awake = b;
    }
    tracing::info!("inherited shared settings from the v1 config");
    Some(cfg)
}

/// Write the config, **preserving every key already in the file that this
/// struct does not know about**.
///
/// The backend and the Tauri host serialise the same `config-rs.json` from two
/// different structs, and the host owns keys this one has never heard of
/// (`default_temperature`, `always_save_docx`). A plain `to_string_pretty(cfg)`
/// deletes them: fall back off a busy port once and the user's drafting
/// preferences silently revert, with nothing in the UI to say why. Merging over
/// the file on disk makes that class of bug impossible rather than merely
/// fixed -- the two schemas may drift again, and drift now costs a stale value
/// instead of a lost setting. The host does the same thing in its own
/// `write_config`.
pub fn save(cfg: &AppConfig) -> Result<()> {
    let path = paths::config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let text = merge_into_existing(cfg, &existing)?;
    fs::write(&path, text).with_context(|| format!("could not write {}", path.display()))?;
    Ok(())
}

/// The merge half of [`save`], split out so it can be tested without writing
/// to the live install's config file.
///
/// `existing` is the raw file contents, or `""` when there is no file. Keys in
/// `existing` that [`AppConfig`] does not define are carried through unchanged.
fn merge_into_existing(cfg: &AppConfig, existing: &str) -> Result<String, serde_json::Error> {
    let mut merged = serde_json::from_str::<serde_json::Value>(existing)
        .ok()
        .and_then(|v| match v {
            serde_json::Value::Object(map) => Some(map),
            // Valid JSON but not an object cannot be merged into, so it is
            // replaced -- same as an unparseable file.
            _ => None,
        })
        .unwrap_or_default();

    let ours = serde_json::to_value(cfg)?;
    if let Some(map) = ours.as_object() {
        for (k, v) in map {
            merged.insert(k.clone(), v.clone());
        }
    }
    serde_json::to_string_pretty(&serde_json::Value::Object(merged))
}

/// Mask a secret for display. Keeps 4 leading + 4 trailing characters.
///
/// The mask is also the round-trip sentinel: a caller that returns this exact
/// string is saying "I did not edit the token", and the stored value is kept.
pub fn mask_token(token: &str) -> String {
    if token.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = token.chars().collect();
    if chars.len() <= 8 {
        return "********".into();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}****{tail}")
}

/// Validate a 5-field cron expression (minute hour dom month dow).
pub fn is_valid_cron(expr: &str) -> bool {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }
    let ranges = [(0u32, 59u32), (0, 23), (1, 31), (1, 12), (0, 7)];
    fields
        .iter()
        .zip(ranges.iter())
        .all(|(field, &(lo, hi))| is_valid_cron_field(field, lo, hi))
}

fn is_valid_cron_field(field: &str, lo: u32, hi: u32) -> bool {
    if field.is_empty() {
        return false;
    }
    field.split(',').all(|part| {
        if part.is_empty() {
            return false;
        }
        let (base, step) = match part.split_once('/') {
            Some((b, s)) => match s.parse::<u32>() {
                Ok(n) if n >= 1 => (b, Some(n)),
                _ => return false,
            },
            None => (part, None),
        };
        if base == "*" {
            return true;
        }
        if let Some((a, b)) = base.split_once('-') {
            return match (a.parse::<u32>(), b.parse::<u32>()) {
                (Ok(a), Ok(b)) => a >= lo && b <= hi && a <= b,
                _ => false,
            };
        }
        // A bare number with a step (`5/2`) is not valid cron.
        if step.is_some() {
            return false;
        }
        matches!(base.parse::<u32>(), Ok(n) if n >= lo && n <= hi)
    })
}

#[cfg(test)]
mod tests {

    #[test]
    fn discovery_either_finds_a_real_executable_or_returns_blank() {
        // Must never return a path that does not exist: a non-empty
        // `llama_server_path` means "supervise this", and a bogus one
        // turns every start into a reported failure.
        let found = discover_llama_server();
        if !found.is_empty() {
            assert!(
                std::path::Path::new(&found).is_file(),
                "discovery returned a path that is not a file: {found}"
            );
            assert!(found.ends_with("llama-server.exe"), "{found}");
        }
    }
    use super::*;

    #[test]
    fn default_token_is_blank() {
        // Hard constraint: a real token must never be a default.
        assert_eq!(AppConfig::default().indiankanoon_token, "");
    }

    #[test]
    fn mask_round_trip_detects_unedited_field() {
        let real = "abcdefghijklmnop";
        let masked = mask_token(real);
        assert_eq!(masked, "abcd****mnop");
        assert_ne!(masked, real);
        // The save path compares against this to decide "unchanged".
        assert_eq!(mask_token(real), masked);
    }

    #[test]
    fn mask_hides_short_tokens_entirely() {
        assert_eq!(mask_token("abc"), "********");
        assert_eq!(mask_token("12345678"), "********");
        assert_eq!(mask_token(""), "");
    }

    #[test]
    fn mask_does_not_panic_on_multibyte() {
        let _ = mask_token("आयकरआयकरआयकर");
    }

    #[test]
    fn cron_accepts_real_schedules() {
        for expr in ["0 12 * * *", "*/15 * * * *", "0 0,12 1-15 * 1-5", "30 2 * * 0"] {
            assert!(is_valid_cron(expr), "should accept {expr}");
        }
    }

    #[test]
    fn cron_rejects_malformed() {
        for expr in ["", "0 12 * *", "0 12 * * * *", "60 12 * * *", "0 24 * * *", "x 12 * * *", "0 12 32 * *", "5/2 * * * *"] {
            assert!(!is_valid_cron(expr), "should reject {expr:?}");
        }
    }

    #[test]
    fn llama_base_url_forms() {
        let mut cfg = AppConfig::default();
        assert_eq!(cfg.llama_base_url(), "http://127.0.0.1:8080");
        cfg.llama_host = "http://localhost:9999/".into();
        assert_eq!(cfg.llama_base_url(), "http://localhost:9999");
    }

    #[test]
    fn a_save_preserves_keys_this_struct_does_not_know() {
        // The bug this pins: the Tauri host owns `default_temperature` and
        // `always_save_docx`; this struct has never heard of them. The save
        // used to be a whole-file overwrite, so falling back off a busy port
        // once erased both -- the user's drafting preferences reverting with
        // no UI telling them why.
        let existing = r#"{
            "backend_port": 8000,
            "default_temperature": 0.7,
            "always_save_docx": false,
            "some_future_key": "keep me"
        }"#;

        let cfg = AppConfig {
            backend_port: 8001,
            ..AppConfig::default()
        };

        let written = merge_into_existing(&cfg, existing).expect("merge");
        let value: serde_json::Value = serde_json::from_str(&written).expect("parse");

        // Ours wins where the two overlap.
        assert_eq!(value["backend_port"], 8001);
        // Theirs survives where we have nothing to say.
        assert_eq!(value["default_temperature"], 0.7);
        assert_eq!(value["always_save_docx"], false);
        assert_eq!(value["some_future_key"], "keep me");
    }

    #[test]
    fn a_save_over_an_unusable_file_still_writes_our_keys() {
        // No file, junk, and valid-JSON-but-not-an-object all have to end in
        // a readable config rather than a hard failure on the fallback-port
        // path, which only logs a warning.
        for existing in ["", "not json at all", "[1, 2, 3]"] {
            let cfg = AppConfig::default();
            let written = merge_into_existing(&cfg, existing).expect("merge");
            let value: serde_json::Value = serde_json::from_str(&written).expect("parse");
            assert_eq!(value["backend_port"], 8000, "for {existing:?}");
            assert_eq!(value["llama_ctx_size"], 8192, "for {existing:?}");
        }
    }
}
