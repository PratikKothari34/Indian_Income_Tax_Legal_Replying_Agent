//! `config.json` read/write, and the Indian Kanoon token mask.
//!
//! # The token mask is load-bearing
//!
//! `get_config` never returns the real `indiankanoon_token`; it returns
//! [`mask_token`] of it. `save_config` compares an incoming token against the
//! mask of the stored one, and **keeps the stored value when they are equal**,
//! because that means the user did not edit the field.
//!
//! Without that check every settings save — even toggling the system tray —
//! would write the mask over the live token and destroy it. The token is
//! per-install state that the user may have pasted in once; there is no second
//! copy to recover from.

use serde::{Deserialize, Serialize};

use crate::paths;

/// Mirrors `DEFAULT_CONFIG` in `backend/paths.py` and the v1 Electron main.
/// **Any key added or changed here must be changed there too** — whichever
/// process writes `config.json` first decides what a fresh install gets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    // --- inference (llama.cpp) ---
    // v2 runs llama.cpp, not Ollama. These names must match
    // `backend-rs/src/config.rs` exactly: both processes serialise the same
    // `config-rs.json`, and a key the host does not know is a key the host
    // used to delete on save.
    pub llama_host: String,
    pub llama_port: u16,
    /// Absolute path to `llama-server.exe`. Empty means "it is already
    /// running; do not spawn it".
    pub llama_server_path: String,
    /// Absolute path to the primary GGUF. Losing this stops drafting, so it
    /// is the key that made unknown-key preservation non-negotiable.
    pub llama_model_path: String,
    pub llama_fallback_model_path: String,
    pub llama_ctx_size: u32,
    pub llama_gpu_layers: u32,
    pub backend_port: u16,
    /// SECRET. Blank in source and in every default. Populated only by the
    /// installer, the Settings panel, or a hand edit. Never logged.
    pub indiankanoon_token: String,
    pub incometax_pdf_scraper_enabled: bool,
    pub rag_sync_schedule: String,
    pub run_at_startup: bool,
    pub system_tray: bool,
    pub keep_awake: bool,

    // --- drafting preferences ---
    // Renderer-only. The backend takes temperature and save_output per
    // request and has no field for either, so it ignores both keys in the
    // file. They live here because a preference the user sets once should
    // survive a restart, and `config-rs.json` is the only per-install store.
    /// Seeds the temperature slider on a fresh draft. Must agree with the
    /// backend's own default, or a user who never opens Settings drafts at
    /// one value while the slider claims another.
    #[serde(default = "default_temperature")]
    pub default_temperature: f32,
    /// Seeds the "save a .docx" switch on a fresh draft.
    #[serde(default = "default_always_save_docx")]
    pub always_save_docx: bool,
}

/// 0.2, matching `backend-rs`. Low on purpose: a tax reply stays close to the
/// statute, and an invented figure in a s.143(2) response is the whole risk.
fn default_temperature() -> f32 {
    0.2
}

fn default_always_save_docx() -> bool {
    true
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            llama_host: "127.0.0.1".into(),
            llama_port: 8080,
            // Empty: discovery and spawning are the backend's job, and an
            // invented path here would be written into a fresh config as if
            // the user had chosen it.
            llama_server_path: String::new(),
            llama_model_path: String::new(),
            llama_fallback_model_path: String::new(),
            llama_ctx_size: 8192,
            // 999 = all layers that fit. The user has a CUDA build.
            llama_gpu_layers: 999,
            backend_port: 8000,
            // An empty token disables the Indian Kanoon auto-scrape; manual
            // ingest still works.
            indiankanoon_token: String::new(),
            // The incometax /news/*.pdf probe is opt-in because Akamai may
            // 403 it depending on the deploy IP.
            incometax_pdf_scraper_enabled: false,
            rag_sync_schedule: "0 12 * * *".into(),
            run_at_startup: false,
            system_tray: true,
            keep_awake: true,
            default_temperature: default_temperature(),
            always_save_docx: default_always_save_docx(),
        }
    }
}

/// Mask the token for display. The renderer only ever needs to know whether a
/// token is set, never its value.
///
/// Must stay byte-identical in behaviour to the v1 `maskToken`, because a
/// user who installed v1 and moves to v2 has the same stored token and the
/// same round-trip expectation.
pub fn mask_token(token: &str) -> String {
    if token.is_empty() {
        return String::new();
    }
    // `chars`, not bytes: a token is ASCII in practice, but slicing a
    // multi-byte string by byte index panics, and a panic here would take out
    // the settings screen.
    let chars: Vec<char> = token.chars().collect();
    if chars.len() <= 8 {
        return "********".into();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}****{tail}")
}

/// Read `config.json`, filling any missing key from [`AppConfig::default`].
/// A missing or corrupt file is rewritten with the defaults.
pub fn read_config() -> AppConfig {
    let path = paths::appdata_config();
    let _ = std::fs::create_dir_all(paths::appdata_base());

    match std::fs::read_to_string(&path) {
        Ok(raw) => {
            // Merge over defaults so a config written by an older version
            // gains new keys instead of failing to parse.
            match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(value) => merge_over_defaults(value),
                Err(_) => {
                    paths::log_line("config.json unparseable; using defaults");
                    AppConfig::default()
                }
            }
        }
        Err(_) => {
            let cfg = AppConfig::default();
            let _ = write_config(&cfg);
            cfg
        }
    }
}

fn merge_over_defaults(value: serde_json::Value) -> AppConfig {
    let mut base = serde_json::to_value(AppConfig::default()).unwrap_or_default();
    if let (Some(base_map), Some(incoming)) = (base.as_object_mut(), value.as_object()) {
        for (k, v) in incoming {
            // Only keys we know about; an unknown key in config.json is
            // ignored rather than failing the whole read.
            if base_map.contains_key(k) && !v.is_null() {
                base_map.insert(k.clone(), v.clone());
            }
        }
    }
    serde_json::from_value(base).unwrap_or_default()
}

/// Write the config, **preserving every key already in the file that this
/// struct does not know about**.
///
/// The host and the backend serialise the same `config-rs.json` from two
/// different structs. A plain `to_string_pretty(cfg)` therefore deletes any
/// key the host has not been taught, and the keys most likely to be missing
/// are the backend's `llama_*` ones -- so toggling the system tray would wipe
/// the user's GGUF path and stop drafting, with nothing in the UI to say why.
/// Merging over the file on disk makes that class of bug impossible rather
/// than merely fixed: the two schemas may drift again, and drift now costs a
/// stale value instead of a destroyed install.
pub fn write_config(cfg: &AppConfig) -> std::io::Result<()> {
    std::fs::create_dir_all(paths::appdata_base())?;
    let path = paths::appdata_config();

    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let json = merge_into_existing(cfg, &existing)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

/// The merge half of [`write_config`], split out so it can be tested without
/// writing to the live install's config file.
///
/// `existing` is the raw file contents, or `""` when there is no file. Keys in
/// `existing` that `AppConfig` does not define are carried through unchanged.
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

/// Validate a 5-field cron expression of the form used by the RAG scheduler.
///
/// Accepts `*`, `*/n`, `a-b`, and comma-separated lists of those, with each
/// numeric value inside the field's range. Anything else is rejected — the
/// value reaches APScheduler, and a malformed one disables the sync silently.
pub fn is_valid_cron(expr: &str) -> bool {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }
    // Day-of-week accepts 7 as a second spelling of Sunday, because
    // `backend-rs/src/config.rs` does. The host is the stricter of the two
    // gates, so a narrower range here rejects a schedule the backend runs
    // happily -- and the user cannot save a config they inherited from v1.
    let ranges = [(0u32, 59u32), (0, 23), (1, 31), (1, 12), (0, 7)];
    fields.iter().zip(ranges.iter()).all(|(field, &(lo, hi))| {
        !field.is_empty()
            && field.split(',').all(|part| {
                if part.is_empty() {
                    return false;
                }
                // Strip an optional step: "*/15" or "1-30/5".
                let (base, step) = match part.split_once('/') {
                    Some((b, s)) => (b, Some(s)),
                    None => (part, None),
                };
                if let Some(s) = step {
                    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
                        return false;
                    }
                    if s.parse::<u32>().map(|v| v == 0).unwrap_or(true) {
                        return false;
                    }
                }
                if base == "*" {
                    return true;
                }
                base.split('-').all(|n| {
                    !n.is_empty()
                        && n.chars().all(|c| c.is_ascii_digit())
                        && n.parse::<u32>().map(|v| v >= lo && v <= hi).unwrap_or(false)
                }) && base.split('-').count() <= 2
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_is_empty_for_unset_token() {
        assert_eq!(mask_token(""), "");
    }

    #[test]
    fn mask_is_fixed_stars_for_short_token() {
        assert_eq!(mask_token("abc"), "********");
        assert_eq!(mask_token("12345678"), "********");
    }

    #[test]
    fn mask_shows_four_each_end_for_long_token() {
        assert_eq!(mask_token("123456789"), "1234****6789");
        assert_eq!(mask_token("abcdefghijklmnop"), "abcd****mnop");
    }

    #[test]
    fn mask_round_trip_detects_unedited_field() {
        // This is the check save_config relies on: the renderer sends back
        // exactly what get_config gave it, so the real token survives.
        let real = "secret-token-value";
        let shown = mask_token(real);
        assert_eq!(shown, mask_token(real));
        assert_ne!(shown, real);
    }

    #[test]
    fn mask_does_not_panic_on_multibyte() {
        let _ = mask_token("ключ-значение-длинное");
    }

    /// Every schedule the Settings picker can produce must survive a save.
    ///
    /// The picker composes its cron in `src/lib/format.ts`, which carries its
    /// own copy of the validation rules. Two independent validators over one
    /// string is exactly the shape that drifts: the UI would let the user
    /// pick a schedule, then the save would reject it with an error naming a
    /// field they never saw. The combinations below are the complete output
    /// space of the picker's controls -- frequency, weekday, and time.
    ///
    /// Monthly is checked too even though the picker no longer offers it:
    /// this validator is also the gate for a cron typed into Advanced or
    /// inherited from v1, and dropping the preset must not stop such a
    /// schedule saving.
    #[test]
    fn every_schedule_the_picker_can_build_is_accepted_here() {
        for (minute, hour) in [(0u32, 0u32), (5, 9), (0, 12), (59, 23)] {
            // Daily.
            assert!(
                is_valid_cron(&format!("{minute} {hour} * * *")),
                "daily {hour}:{minute} rejected"
            );
            // Weekly, every day the picker offers. 0 is Sunday. The picker
            // has one Sunday entry and spells it 0; that 7 is also legal
            // here is pinned separately, below.
            for weekday in 0..=6 {
                assert!(
                    is_valid_cron(&format!("{minute} {hour} * * {weekday}")),
                    "weekly on day {weekday} at {hour}:{minute} rejected"
                );
            }
            // Monthly, no longer a preset but still valid to save. The
            // validator accepts up to 31; 1-28 is the range that cannot
            // skip a short month, which is why it is the range checked.
            for day in 1..=28 {
                assert!(
                    is_valid_cron(&format!("{minute} {hour} {day} * *")),
                    "monthly on the {day} at {hour}:{minute} rejected"
                );
            }
        }
    }

    /// Sunday has two spellings and both must pass.
    ///
    /// This caught real drift: `src/lib/format.ts` capped day-of-week at 6
    /// while this validator and the backend both accept 7, so the Settings
    /// panel called a schedule invalid that saves and runs -- including one
    /// a user could have inherited from v1. The frontend was widened to
    /// match. If this range ever changes, `CRON_FIELDS` in `format.ts` is
    /// the other copy.
    #[test]
    fn sunday_is_accepted_as_both_zero_and_seven() {
        assert!(is_valid_cron("0 8 * * 0"));
        assert!(is_valid_cron("0 8 * * 7"));
        assert!(!is_valid_cron("0 8 * * 8"));
    }

    #[test]
    fn cron_accepts_the_shipped_default() {
        assert!(is_valid_cron("0 12 * * *"));
    }

    #[test]
    fn cron_accepts_steps_lists_and_ranges() {
        assert!(is_valid_cron("*/15 * * * *"));
        assert!(is_valid_cron("0 9,17 * * 1-5"));
        assert!(is_valid_cron("30 2 1 1-6 *"));
    }

    #[test]
    fn cron_rejects_malformed() {
        assert!(!is_valid_cron(""));
        assert!(!is_valid_cron("0 12 * *"));
        assert!(!is_valid_cron("0 12 * * * *"));
        assert!(!is_valid_cron("60 12 * * *"));
        assert!(!is_valid_cron("0 24 * * *"));
        assert!(!is_valid_cron("0 12 0 * *"));
        assert!(!is_valid_cron("0 12 * 13 *"));
        // 7 is Sunday, same as `backend-rs`; see the ranges comment.
        assert!(is_valid_cron("0 12 * * 7"));
        assert!(!is_valid_cron("0 12 * * 8"));
        assert!(!is_valid_cron("abc 12 * * *"));
        assert!(!is_valid_cron("*/0 * * * *"));
    }

    #[test]
    fn default_token_is_blank() {
        // Hard constraint: a real token must never be a default.
        assert_eq!(AppConfig::default().indiankanoon_token, "");
    }

    #[test]
    fn a_save_preserves_keys_this_struct_does_not_know() {
        // The bug this pins: the backend owns `llama_*`, the host owned none
        // of them, and the host's save was a whole-file overwrite -- so
        // toggling the system tray deleted the user's model path and drafting
        // stopped with nothing in the UI to explain it.
        let existing = r#"{
            "system_tray": false,
            "llama_model_path": "D:/models/qwen2.5-7b-instruct-q4_k_m.gguf",
            "a_key_from_a_future_version": 42
        }"#;

        // The real save path is read-then-write: `save_config` starts from
        // `read_config()`, so a key the host now defines is carried in the
        // struct, and a key it does not define is carried by the file merge.
        // Both halves are needed -- this reproduces the first half.
        let current = merge_over_defaults(
            serde_json::from_str(existing).expect("fixture parses"),
        );
        assert_eq!(
            current.llama_model_path, "D:/models/qwen2.5-7b-instruct-q4_k_m.gguf",
            "a read must not lose a key the host defines"
        );

        let mut cfg = current.clone();
        cfg.system_tray = true;

        let written = merge_into_existing(&cfg, existing).expect("merge");
        let value: serde_json::Value = serde_json::from_str(&written).expect("parse");

        assert_eq!(
            value["llama_model_path"], "D:/models/qwen2.5-7b-instruct-q4_k_m.gguf",
            "the model path must survive an unrelated toggle"
        );
        assert_eq!(
            value["a_key_from_a_future_version"], 42,
            "an unknown key from a newer version must survive too"
        );
        // ...while the key we did set still wins.
        assert_eq!(value["system_tray"], true);
    }

    #[test]
    fn a_blank_known_key_does_not_overwrite_a_real_value() {
        // The narrower half of the same bug: once the host *defines*
        // `llama_model_path`, its empty default is a value, and writing a
        // struct built from `AppConfig::default()` rather than from
        // `read_config()` would blank a real path. Any future save path must
        // start from the file, never from the defaults.
        let existing = r#"{"llama_model_path": "D:/models/real.gguf"}"#;
        let written = merge_into_existing(&AppConfig::default(), existing).expect("merge");
        let value: serde_json::Value = serde_json::from_str(&written).expect("parse");
        assert_eq!(
            value["llama_model_path"], "",
            "documents the hazard: defaults DO overwrite, so save must read first"
        );

        // Read-then-write, the path `save_config` actually takes, is safe.
        let current = merge_over_defaults(serde_json::from_str(existing).expect("parse"));
        let written = merge_into_existing(&current, existing).expect("merge");
        let value: serde_json::Value = serde_json::from_str(&written).expect("parse");
        assert_eq!(value["llama_model_path"], "D:/models/real.gguf");
    }

    #[test]
    fn a_missing_or_corrupt_config_still_writes_cleanly() {
        let cfg = AppConfig::default();
        for existing in ["", "not json at all", "[1,2,3]", "null"] {
            let written = merge_into_existing(&cfg, existing).expect("merge");
            let value: serde_json::Value = serde_json::from_str(&written).expect("parse");
            assert!(
                value.get("llama_model_path").is_some(),
                "defaults must be written for input {existing:?}"
            );
        }
    }

    /// The installer seeds `config-rs.json` on a fresh install, which makes
    /// it a **third copy** of the config defaults alongside this file and
    /// `backend-rs`. A key added here but not there means a fresh install
    /// starts without it; the user then hits a default they never chose and
    /// cannot see. Checked mechanically because nobody re-reads an NSIS
    /// script when adding a struct field.
    #[test]
    fn the_installer_seeds_every_key_the_host_knows() {
        let nsh = include_str!("../installer.nsh");

        // Lines look like a quoted JSON fragment, one key per FileWrite.
        let seeded: Vec<&str> = nsh
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                if !line.starts_with("FileWrite") {
                    return None;
                }
                let after = line.split_once('"')?.1;
                let (key, rest) = after.split_once('"')?;
                // Only `"key":` pairs, not the braces or other writes.
                rest.trim_start().starts_with(':').then_some(key)
            })
            .collect();

        let known = AppConfig::default();
        let known = serde_json::to_value(&known).expect("AppConfig serializes");
        let known = known.as_object().expect("a JSON object");

        for key in known.keys() {
            assert!(
                seeded.contains(&key.as_str()),
                "installer.nsh does not seed `{key}`; a fresh install would                  start without it. Add it there too."
            );
        }
        for key in &seeded {
            assert!(
                known.contains_key(*key),
                "installer.nsh seeds `{key}`, which AppConfig does not have.                  A stale key here is how v1's ollama_* settings outlived v1."
            );
        }
        assert_eq!(
            seeded.len(),
            known.len(),
            "a key is seeded twice; the later write silently wins"
        );
    }

    #[test]
    fn the_host_and_backend_agree_on_the_config_key_set() {
        // Both processes serialise the same file. A key in one and not the
        // other is the drift that finding #1 was: caught here as a list the
        // reader can diff, rather than at runtime as a deleted model path.
        let ours = serde_json::to_value(AppConfig::default()).expect("serialise");
        let keys: Vec<&str> = ours
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        for expected in [
            "llama_host",
            "llama_port",
            "llama_server_path",
            "llama_model_path",
            "llama_fallback_model_path",
            "llama_ctx_size",
            "llama_gpu_layers",
            "backend_port",
            "rag_sync_schedule",
            "indiankanoon_token",
            "incometax_pdf_scraper_enabled",
            "run_at_startup",
            "system_tray",
            "keep_awake",
        ] {
            assert!(keys.contains(&expected), "host config is missing {expected}");
        }
        assert!(
            !keys.iter().any(|k| k.starts_with("ollama")),
            "v2 runs llama.cpp; an ollama_* key here is v1 residue"
        );
    }

    #[test]
    fn drafting_preferences_are_host_only_and_survive_an_older_config() {
        // The list above is one-directional on purpose: the host must carry
        // every key the backend knows, but may carry more. These two are
        // renderer preferences -- the backend takes temperature and
        // save_output per request -- so they are deliberately absent from
        // `backend-rs`, and adding them there would be the wrong fix for a
        // failure of the test above.
        let cfg = AppConfig::default();
        assert_eq!(cfg.default_temperature, 0.2);
        assert!(cfg.always_save_docx);

        // A config written before these keys existed must still parse, and
        // must come back with the defaults rather than zero. `0.0` would be
        // a silent behaviour change: greedy sampling on every fresh draft.
        let older = r#"{"llama_model_path":"C:/m.gguf","backend_port":8001}"#;
        let parsed = merge_over_defaults(serde_json::from_str(older).expect("fixture parses"));
        assert_eq!(parsed.default_temperature, 0.2);
        assert!(parsed.always_save_docx);
        assert_eq!(parsed.llama_model_path, "C:/m.gguf");
    }

    #[test]
    fn a_preference_the_host_does_not_know_survives_a_write() {
        // The same guarantee the llama_* keys rely on, asserted for the two
        // new ones from the other side: a file holding a key this struct
        // does not define keeps it.
        let cfg = AppConfig::default();
        let existing = r#"{"some_future_key":"keep me","always_save_docx":false}"#;
        let written = merge_into_existing(&cfg, existing).expect("merge");
        let value: serde_json::Value = serde_json::from_str(&written).expect("parse");
        assert_eq!(value["some_future_key"], "keep me");
    }
}
