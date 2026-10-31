//! Per-session conversation store, one JSON file per session.
//! Ports `backend/services/session_store.py`, including the bugs it fixed.
//!
//! File shape (unchanged from v1, so the frontend reads either stack's files):
//!
//! ```json
//! {
//!   "session_id": "<12-hex>",
//!   "created_at": "2026-05-03T16:10:46",
//!   "updated_at": "2026-05-03T16:26:35",
//!   "turns": [{ "timestamp", "model", "notice_text", "query", "reply", "output_file" }]
//! }
//! ```
//!
//! # The concurrency lock is load-bearing
//!
//! Generation takes minutes, so two overlapping `/generate` calls are easy to
//! hit (a second window, or a script driving the HTTP API). Without
//! serialising the read-modify-write, v1 lost turns three ways: both writers
//! started from the same snapshot so one append vanished; the rename failed
//! with a sharing violation on Windows because another writer held the
//! destination open; and a reader catching a half-written file quarantined a
//! good session as corrupt. v1 measured 38 of 40 turns lost under
//! concurrency. The mutex plus write-temp-then-rename is what fixes it.
//!
//! # Session ids are a filesystem primitive
//!
//! The id is interpolated into a filename. An unvalidated value such as
//! `../../../config` escapes the data directory and lets a client write JSON
//! anywhere on disk. Validation is not optional.

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use chrono::Local;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::paths;

/// Serialises every read-modify-write on the session directory.
static WRITE_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionTurn {
    pub timestamp: String,
    pub model: String,
    pub notice_text: String,
    pub query: String,
    pub reply: String,
    /// Empty string when nothing was saved — matches v1, which the frontend
    /// already treats as "no file".
    #[serde(default)]
    pub output_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    pub session_id: String,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub turns: Vec<SessionTurn>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub turn_count: usize,
}

/// A session id is a generated 12-hex token or a caller-supplied value
/// continuing an existing conversation. Mirrors `_SESSION_ID_RE`.
pub fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn now_iso() -> String {
    // Seconds precision, local time, matching v1's isoformat(timespec="seconds").
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn path_for(session_id: &str) -> Result<PathBuf> {
    if !is_valid_session_id(session_id) {
        return Err(anyhow!("invalid session id"));
    }
    Ok(paths::data_dir().join(format!("session_{session_id}.json")))
}

fn new_session_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes) // 12 hex chars, matching v1
}

/// Append one turn, creating the session when `session_id` is `None`.
/// Returns the session id to pass back on the next turn.
#[allow(clippy::too_many_arguments)]
pub async fn append_turn(
    session_id: Option<&str>,
    notice_text: &str,
    query: &str,
    reply: &str,
    model: &str,
    output_file: &str,
) -> Result<String> {
    let _guard = WRITE_LOCK.lock().await;

    let sid = match session_id {
        Some(s) if !s.is_empty() => {
            if !is_valid_session_id(s) {
                return Err(anyhow!("invalid session id"));
            }
            s.to_string()
        }
        _ => new_session_id(),
    };

    let path = path_for(&sid)?;
    tokio::fs::create_dir_all(paths::data_dir()).await.ok();

    let mut session = match tokio::fs::read_to_string(&path).await {
        Ok(text) => serde_json::from_str::<StoredSession>(&text).unwrap_or_else(|e| {
            // A corrupt file must not block the turn the user just paid
            // minutes of inference for. Start a fresh document; the damaged
            // one is overwritten rather than lost silently mid-request.
            tracing::warn!("session {sid} was unreadable ({e}); starting a new document");
            StoredSession {
                session_id: sid.clone(),
                created_at: now_iso(),
                updated_at: String::new(),
                turns: Vec::new(),
            }
        }),
        Err(_) => StoredSession {
            session_id: sid.clone(),
            created_at: now_iso(),
            updated_at: String::new(),
            turns: Vec::new(),
        },
    };

    let stamp = now_iso();
    session.turns.push(SessionTurn {
        timestamp: stamp.clone(),
        model: model.to_string(),
        notice_text: notice_text.to_string(),
        query: query.to_string(),
        reply: reply.to_string(),
        output_file: output_file.to_string(),
    });
    session.updated_at = stamp;
    session.session_id = sid.clone();

    write_atomic(&path, &session).await?;
    Ok(sid)
}

/// Write to a temp file in the same directory, then rename over the target.
///
/// Same-directory is required: a rename across volumes is not atomic.
///
/// The temp name is the session's own path with the extension swapped, so two
/// writers working on *different* sessions get different temp files for free
/// -- the distinct stems do that, not the pid suffix. The pid guards the
/// other case: a second backend process (the dynamic-port fallback makes one
/// possible) writing the same session concurrently would otherwise share a
/// temp path and interleave bytes in it. It does not make the two processes
/// safe overall -- `WRITE_LOCK` is per-process, so their renames still race
/// and the later one wins. Only one backend is ever meant to own the data
/// directory; this keeps the failure to a lost turn rather than a corrupt
/// file.
async fn write_atomic(path: &PathBuf, session: &StoredSession) -> Result<()> {
    let text = serde_json::to_string_pretty(session)?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    tokio::fs::write(&tmp, text.as_bytes())
        .await
        .with_context(|| format!("could not write {}", tmp.display()))?;
    match tokio::fs::rename(&tmp, path).await {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            Err(e).with_context(|| format!("could not replace {}", path.display()))
        }
    }
}

/// List sessions newest-first.
///
/// Per-file fault tolerance is deliberate: one corrupt session must not blank
/// the whole sidebar, which is what a single parse failure would do if it
/// aborted the listing.
pub async fn list_sessions() -> Vec<SessionSummary> {
    let dir = paths::data_dir();
    let mut out: Vec<SessionSummary> = Vec::new();
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(e) => e,
        Err(_) => return out,
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("session_") || !name.ends_with(".json") {
            continue;
        }
        let text = match tokio::fs::read_to_string(entry.path()).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("skipping unreadable session {name}: {e}");
                continue;
            }
        };
        let parsed = match serde_json::from_str::<StoredSession>(&text) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("skipping corrupt session {name}: {e}");
                continue;
            }
        };
        // Fall back to the filename when the document lacks its own id.
        let session_id = if parsed.session_id.is_empty() {
            name.trim_start_matches("session_")
                .trim_end_matches(".json")
                .to_string()
        } else {
            parsed.session_id
        };
        let updated_at = if parsed.updated_at.is_empty() {
            parsed.created_at.clone()
        } else {
            parsed.updated_at
        };
        out.push(SessionSummary {
            session_id,
            created_at: parsed.created_at,
            updated_at,
            turn_count: parsed.turns.len(),
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

pub async fn read_session(session_id: &str) -> Result<StoredSession> {
    let path = path_for(session_id)?;
    let text = tokio::fs::read_to_string(&path)
        .await
        .with_context(|| format!("session {session_id} not found"))?;
    serde_json::from_str(&text).with_context(|| format!("session {session_id} is corrupt"))
}

pub async fn delete_session(session_id: &str) -> Result<()> {
    let _guard = WRITE_LOCK.lock().await;
    let path = path_for(session_id)?;
    // Containment check: path_for validates the id, and this re-checks the
    // resulting path in case the data dir is ever made configurable.
    if !paths::is_within(&paths::data_dir(), &path) {
        return Err(anyhow!("refusing to delete outside the data directory"));
    }
    tokio::fs::remove_file(&path)
        .await
        .with_context(|| format!("could not delete session {session_id}"))?;
    Ok(())
}

/// Rebuild the chat history a client should send on the next turn.
pub fn history_from(session: &StoredSession) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for turn in &session.turns {
        let user = if turn.query.trim().is_empty() {
            turn.notice_text.clone()
        } else {
            turn.query.clone()
        };
        out.push(("user".to_string(), user));
        out.push(("assistant".to_string(), turn.reply.clone()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_real_ids() {
        assert!(is_valid_session_id("a1b2c3d4e5f6"));
        assert!(is_valid_session_id("my_session-1"));
        assert!(is_valid_session_id(&"x".repeat(64)));
    }

    #[test]
    fn rejects_traversal_payloads() {
        for bad in [
            "../../config",
            r"..\..\config",
            "a/b",
            r"a\b",
            "a.b",
            "..",
            ".",
            "",
            "a b",
            "sess;rm",
        ] {
            assert!(!is_valid_session_id(bad), "must reject {bad:?}");
        }
    }

    #[test]
    fn rejects_overlong_and_control_chars() {
        assert!(!is_valid_session_id(&"x".repeat(65)));
        assert!(!is_valid_session_id("a\0b"));
        assert!(!is_valid_session_id("a\nb"));
    }

    #[test]
    fn path_for_rejects_invalid_id() {
        assert!(path_for("../../etc").is_err());
        assert!(path_for("ok-1").is_ok());
    }

    #[test]
    fn generated_ids_are_valid_and_distinct() {
        let a = new_session_id();
        let b = new_session_id();
        assert_eq!(a.len(), 12);
        assert!(is_valid_session_id(&a));
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn append_then_read_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("ITAX_BASE_DIR_OVERRIDE", tmp.path());
        tokio::fs::create_dir_all(paths::data_dir()).await.unwrap();

        let sid = append_turn(None, "notice", "q", "reply", "m", "")
            .await
            .unwrap();
        let session = read_session(&sid).await.unwrap();
        assert_eq!(session.turns.len(), 1);
        assert_eq!(session.turns[0].reply, "reply");

        append_turn(Some(&sid), "n2", "q2", "r2", "m", "")
            .await
            .unwrap();
        let session = read_session(&sid).await.unwrap();
        assert_eq!(session.turns.len(), 2, "append must not overwrite");
        assert!(!session.updated_at.is_empty());

        std::env::remove_var("ITAX_BASE_DIR_OVERRIDE");
    }

    #[tokio::test]
    async fn concurrent_appends_lose_no_turns() {
        // This is the v1 bug the lock exists for: 38 of 40 turns were lost.
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("ITAX_BASE_DIR_OVERRIDE", tmp.path());
        tokio::fs::create_dir_all(paths::data_dir()).await.unwrap();

        let sid = append_turn(None, "n", "q", "seed", "m", "").await.unwrap();
        let mut tasks = Vec::new();
        for i in 0..40 {
            let sid = sid.clone();
            tasks.push(tokio::spawn(async move {
                append_turn(Some(&sid), "n", &format!("q{i}"), "r", "m", "").await
            }));
        }
        for t in tasks {
            t.await.unwrap().unwrap();
        }
        let session = read_session(&sid).await.unwrap();
        assert_eq!(session.turns.len(), 41, "every concurrent append must land");

        std::env::remove_var("ITAX_BASE_DIR_OVERRIDE");
    }
}
