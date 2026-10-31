//! Session files on disk: `session_<id>.json` under the data dir.
//!
//! Every id that arrives from the renderer is validated before it touches the
//! filesystem. The id is interpolated into a filename, so an unvalidated value
//! is a path-traversal primitive — `../../../config.json` would read a secret.

use serde::Serialize;

use crate::paths;

/// Mirrors `_SESSION_ID_RE` in `backend/routes/generate.py` and
/// `session_store.py`. Keep all three in agreement.
pub fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[derive(Debug, Serialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub turn_count: usize,
}

/// List every session, newest first.
///
/// Per-file fault tolerance is deliberate: one unreadable or corrupt session
/// file must not blank the whole sidebar. A bad file is skipped and logged.
pub fn list_sessions() -> Vec<SessionSummary> {
    let dir = paths::data_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut out: Vec<SessionSummary> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_session = name.to_ascii_lowercase().starts_with("session_")
            && name.to_ascii_lowercase().ends_with(".json");
        if !is_session || !entry.path().is_file() {
            continue;
        }
        let raw = match std::fs::read_to_string(entry.path()) {
            Ok(r) => r,
            Err(_) => {
                paths::log_line(&format!("list_sessions: skipping unreadable file {name}"));
                continue;
            }
        };
        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => {
                paths::log_line(&format!("list_sessions: skipping corrupt file {name}"));
                continue;
            }
        };

        // Fall back to the filename when the JSON has no session_id, matching
        // v1 behaviour so a hand-written file still shows up.
        let id_from_name = name
            .trim_start_matches("session_")
            .trim_start_matches("SESSION_")
            .trim_end_matches(".json")
            .trim_end_matches(".JSON")
            .to_string();
        let session_id = parsed
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or(&id_from_name)
            .to_string();
        let created_at = parsed
            .get("created_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let updated_at = parsed
            .get("updated_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| created_at.clone());
        let turn_count = parsed
            .get("turns")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);

        out.push(SessionSummary {
            session_id,
            created_at,
            updated_at,
            turn_count,
        });
    }

    // Newest first, matching the v1 sidebar order.
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

pub fn read_session(session_id: &str) -> Result<serde_json::Value, String> {
    if !is_valid_session_id(session_id) {
        return Err("Invalid session id.".into());
    }
    let path = paths::data_dir().join(format!("session_{session_id}.json"));
    let raw = std::fs::read_to_string(&path).map_err(|_| "Session not found.".to_string())?;
    serde_json::from_str(&raw).map_err(|_| "Session file is corrupt.".to_string())
}

pub fn delete_session(session_id: &str) -> Result<(), String> {
    if !is_valid_session_id(session_id) {
        return Err("Invalid session id.".into());
    }
    let path = paths::data_dir().join(format!("session_{session_id}.json"));
    if !path.exists() {
        return Err("Session file not found.".into());
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_real_backend_id() {
        // The backend mints a 12-hex id.
        assert!(is_valid_session_id("a1b2c3d4e5f6"));
        assert!(is_valid_session_id("my-session_01"));
    }

    #[test]
    fn rejects_traversal_payloads() {
        assert!(!is_valid_session_id("../../config"));
        assert!(!is_valid_session_id("..\\..\\config"));
        assert!(!is_valid_session_id("a/b"));
        assert!(!is_valid_session_id("a\\b"));
        assert!(!is_valid_session_id("a.b"));
        assert!(!is_valid_session_id(".."));
    }

    #[test]
    fn rejects_empty_and_overlong() {
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id(&"a".repeat(65)));
        assert!(is_valid_session_id(&"a".repeat(64)));
    }

    #[test]
    fn rejects_null_byte_and_control_chars() {
        assert!(!is_valid_session_id("abc\0def"));
        assert!(!is_valid_session_id("abc\ndef"));
    }
}
