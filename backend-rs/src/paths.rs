//! Runtime path + config resolution. Mirrors `backend/paths.py`.
//!
//! # Why this does not share `config.json` with v1
//!
//! The Python backend's `config.json` holds a **live** Indian Kanoon token.
//! Two backends writing one file races, and a v2 bug could overwrite the only
//! copy of that credential. v2 therefore reads v1's config when present (so a
//! user does not retype settings) but **writes only to its own file**.
//!
//! Hard constraint carried over: `BASE_DIR` must never be re-pointed. On a
//! packaged install it is `%LOCALAPPDATA%\ITaxReplyAgent`; changing it orphans
//! every session, output, upload and vector of an existing install.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Ports tried in order when the configured port is bound.
/// Mirrors `paths.py::PORT_FALLBACK_CHAIN` and the Tauri CSP `connect-src`.
/// A change here must be mirrored in both.
pub const PORT_FALLBACK_CHAIN: [u16; 4] = [8000, 8001, 8002, 8003];

/// True when running from a packaged build rather than `cargo run`.
///
/// Matches the Tauri host's convention (`!cfg!(debug_assertions)`) rather than
/// an env var: an env var can be set accidentally in a shell and silently
/// move a developer's data root to AppData.
pub fn is_packaged() -> bool {
    !cfg!(debug_assertions)
}

/// On-disk root for runtime data.
///
/// * `ITAX_BASE_DIR_OVERRIDE` wins — the test suite points it at a temp dir so
///   a run never reads or rewrites the real `config.json`.
/// * Packaged → `%LOCALAPPDATA%\ITaxReplyAgent`.
/// * Dev → the `backend/` folder, so v1 and v2 see the same dev layout.
pub fn base_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("ITAX_BASE_DIR_OVERRIDE") {
        if !override_dir.trim().is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    if is_packaged() {
        let local = std::env::var("LOCALAPPDATA").ok().map(PathBuf::from).or_else(|| {
            dirs::home_dir().map(|h| h.join("AppData").join("Local"))
        });
        return local
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ITaxReplyAgent");
    }
    // Dev: <repo>/backend, matching the Python backend's dev root.
    manifest_sibling("backend")
}

/// A path next to this crate's manifest directory, used for dev-mode layout.
fn manifest_sibling(name: &str) -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(|p| p.join(name))
        .unwrap_or_else(|| manifest.join(name))
}

pub fn data_dir() -> PathBuf {
    base_dir().join("data")
}
pub fn output_dir() -> PathBuf {
    base_dir().join("output")
}
pub fn uploads_dir() -> PathBuf {
    base_dir().join("uploads")
}
pub fn logs_dir() -> PathBuf {
    base_dir().join("logs")
}

/// v2's own config file. **Never** `config.json` — see the module docs.
pub fn config_path() -> PathBuf {
    base_dir().join("config-rs.json")
}

/// v1's config, read-only. Used to inherit settings on first run.
pub fn legacy_config_path() -> PathBuf {
    base_dir().join("config.json")
}

/// v2 writes its own port file so both backends can run side by side.
pub fn port_file() -> PathBuf {
    base_dir().join("port-rs.txt")
}

/// Per-install bearer token for `X-ITax-Auth`.
///
/// Shared with v1 deliberately: the frontend reads one token and must be able
/// to drive either backend. The file is created only if missing, never
/// rewritten — rotating it would break a running v1 install.
pub fn auth_token_path() -> PathBuf {
    base_dir().join("auth_token.txt")
}

pub fn rag_dir() -> PathBuf {
    base_dir().join("rag")
}
pub fn rag_docs_dir() -> PathBuf {
    rag_dir().join("docs")
}
/// v2's vector store. Separate from `rag/chromadb/` by necessity: no Rust
/// client can read a Python ChromaDB sqlite+hnswlib store, and pointing at it
/// would risk corrupting vectors an installed v1 still depends on.
pub fn rag_vectors_dir() -> PathBuf {
    rag_dir().join("vectors-rs")
}
/// Shared with v1 — same ONNX/sentence-transformers model cache, so a user who
/// already synced does not download the 90 MB model twice.
pub fn rag_models_dir() -> PathBuf {
    rag_dir().join("models")
}
pub fn rag_sync_status() -> PathBuf {
    rag_dir().join("sync_status-rs.json")
}

/// Create every runtime directory. Safe to call repeatedly.
pub fn ensure_dirs() -> Result<()> {
    for dir in [
        base_dir(),
        data_dir(),
        output_dir(),
        uploads_dir(),
        logs_dir(),
        rag_dir(),
        rag_docs_dir(),
        rag_vectors_dir(),
        rag_models_dir(),
    ] {
        fs::create_dir_all(&dir)
            .with_context(|| format!("could not create {}", dir.display()))?;
    }
    Ok(())
}

/// Pin the Hugging Face cache to `rag/models` before any embedding model load.
///
/// Without this the ONNX model lands in `%USERPROFILE%\.cache\huggingface`,
/// outside the uninstall target, and a packaged install leaves ~90 MB behind.
pub fn configure_hf_cache() {
    let models = rag_models_dir();
    let _ = fs::create_dir_all(&models);
    for key in [
        "HF_HOME",
        "TRANSFORMERS_CACHE",
        "SENTENCE_TRANSFORMERS_HOME",
        "FASTEMBED_CACHE_PATH",
    ] {
        std::env::set_var(key, &models);
    }
    std::env::set_var("HF_HUB_DISABLE_TELEMETRY", "1");
}

/// Write the actually-bound port so the frontend can find this backend.
pub fn write_port(port: u16) -> Result<()> {
    let path = port_file();
    fs::write(&path, port.to_string())
        .with_context(|| format!("could not write {}", path.display()))?;
    Ok(())
}

/// Read or mint the per-install auth token.
///
/// Created with 32 bytes of randomness on first call. An existing file is
/// returned untouched: v1 and the frontend already hold that value, and
/// rotating it without the user asking breaks the running install.
pub fn ensure_auth_token() -> Result<String> {
    ensure_auth_token_at(&auth_token_path())
}

/// The read-or-mint logic, against a caller-supplied path.
///
/// Split out so the no-rotation guarantee can be tested without pointing a
/// test at the live token file or mutating `ITAX_BASE_DIR_OVERRIDE`, which is
/// process-global and would race the other tests running in parallel.
fn ensure_auth_token_at(path: &Path) -> Result<String> {
    if let Ok(existing) = fs::read_to_string(path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, &token)
        .with_context(|| format!("could not write {}", path.display()))?;
    Ok(token)
}

/// Component-wise containment check.
///
/// Deliberately not `starts_with` on strings: `...\ITaxReplyAgent_evil` passes
/// a string-prefix test but is not inside `...\ITaxReplyAgent`.
pub fn is_within(base: &Path, candidate: &Path) -> bool {
    let base: Vec<_> = base.components().collect();
    let cand: Vec<_> = candidate.components().collect();
    if cand.len() < base.len() {
        return false;
    }
    base.iter().zip(cand.iter()).all(|(a, b)| a == b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn containment_accepts_self_and_children() {
        let base = Path::new(r"C:\Users\x\AppData\Local\ITaxReplyAgent");
        assert!(is_within(base, base));
        assert!(is_within(base, &base.join("output").join("a.docx")));
    }

    #[test]
    fn containment_rejects_sibling_prefix() {
        // The bug a string starts_with() check would have.
        let base = Path::new(r"C:\Users\x\AppData\Local\ITaxReplyAgent");
        let evil = Path::new(r"C:\Users\x\AppData\Local\ITaxReplyAgent_evil\p.docx");
        assert!(!is_within(base, evil));
    }

    #[test]
    fn containment_rejects_parent_and_unrelated() {
        let base = Path::new(r"C:\Users\x\AppData\Local\ITaxReplyAgent");
        assert!(!is_within(base, Path::new(r"C:\Users\x\AppData\Local")));
        assert!(!is_within(base, Path::new(r"D:\elsewhere")));
    }

    #[test]
    fn v2_never_writes_the_v1_config() {
        // Hard constraint: config.json holds a live token. v2 owns a
        // different filename and this test is what keeps it that way.
        assert_ne!(config_path(), legacy_config_path());
        assert!(config_path().ends_with("config-rs.json"));
    }

    #[test]
    fn auth_token_is_shared_with_v1() {
        // The frontend holds one token and must drive either backend.
        assert!(auth_token_path().ends_with("auth_token.txt"));
    }

    /// A scratch path under the OS temp dir, unique per test.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("itax-rs-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir.join("auth_token.txt")
    }

    #[test]
    fn an_absent_token_is_minted_as_64_hex_chars() {
        let path = scratch("mint");
        let token = ensure_auth_token_at(&path).expect("should mint");
        assert_eq!(token.len(), 64, "32 random bytes, hex encoded");
        assert!(
            token.chars().all(|c| c.is_ascii_hexdigit()),
            "token is not hex"
        );
        assert!(path.exists(), "the token was not persisted");
        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn an_existing_token_is_never_rotated() {
        // Hard constraint: rotating a token the user did not ask to rotate
        // breaks the running install. Two calls must agree.
        let path = scratch("stable");
        let first = ensure_auth_token_at(&path).expect("first");
        let second = ensure_auth_token_at(&path).expect("second");
        assert_eq!(first, second, "the token was rotated on a second call");
        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn a_blank_token_file_is_replaced_rather_than_returned() {
        // An empty or whitespace-only file is a failed earlier write, not a
        // valid token. Returning it would authenticate every caller.
        let path = scratch("blank");
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(&path, "   \n").expect("write blank");
        let token = ensure_auth_token_at(&path).expect("should mint over blank");
        assert_eq!(token.len(), 64);
        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }
}
