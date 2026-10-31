//! AppData layout. **Must match `backend-rs/src/paths.rs` exactly** — that is
//! the process this host launches. (v1's `backend/paths.py` shares the same
//! base directory, but not the same file names: v2 owns `config-rs.json`,
//! `port-rs.txt` and `rag/vectors-rs/`.)
//!
//! Dev and production resolve differently, and the switch is whether the
//! build is packaged — never an environment variable. In dev the backend
//! writes to `backend/data`, `backend/output` and `backend/auth_token.txt`
//! inside the repo; validating a dev path against AppData would reject every
//! real path and silently open the wrong (empty) folder.

use std::path::{Path, PathBuf};

/// `%LOCALAPPDATA%`, falling back to `~/AppData/Local` when the variable is
/// absent (it is set on every supported Windows configuration, but a missing
/// value must not panic the app at startup).
fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join("AppData").join("Local")))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn appdata_base() -> PathBuf {
    local_app_data().join("ITaxReplyAgent")
}

/// v2's own config file.
///
/// **Not `config.json`.** That one belongs to the Python backend, which is
/// still the stable fallback and may be installed alongside this. v2 reads
/// v1's file once to inherit settings but never writes it, so the two can
/// share a machine without either corrupting the other's state.
/// Branches on `is_packaged()` for the same reason its neighbours do: in dev
/// `backend-rs` resolves this to `<repo>/backend/config-rs.json`, so a host
/// that always read AppData would edit a file the running backend never
/// looks at — Settings would appear to save and change nothing.
pub fn appdata_config() -> PathBuf {
    config_base().join("config-rs.json")
}

/// v2's own port file, written by `backend-rs` once it has bound.
///
/// **Not `port.txt`.** If both backends are installed and this read v1's
/// file, the shell would send every request to whichever process wrote last
/// - usually the wrong one, and silently.
pub fn appdata_port_file() -> PathBuf {
    config_base().join("port-rs.txt")
}

pub fn appdata_logs() -> PathBuf {
    config_base().join("logs")
}

/// Where the runtime files the host shares with `backend-rs` actually live:
/// AppData when packaged, `<repo>/backend` in dev. This mirrors
/// `backend-rs::paths::base_dir`, and the two must not drift — the config,
/// the port file and the logs are all written by one process and read by the
/// other.
fn config_base() -> PathBuf {
    if is_packaged() {
        appdata_base()
    } else {
        repo_root().join("backend")
    }
}

pub fn appdata_rag_models() -> PathBuf {
    appdata_base().join("rag").join("models")
}

pub fn frontend_log() -> PathBuf {
    appdata_logs().join("frontend.log")
}

/// True when this is a bundled build rather than `tauri dev`.
///
/// `cfg!(debug_assertions)` is the signal Tauri itself uses: a `tauri build`
/// is a release profile, `tauri dev` is a debug profile. This is compiled in,
/// so unlike an env var it cannot be flipped at runtime by the environment.
pub fn is_packaged() -> bool {
    !cfg!(debug_assertions)
}

/// The repo root, used only in dev. The dev binary lives at
/// `frontend-v2/src-tauri/target/debug/`, so the root is four levels up.
fn repo_root() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")); // frontend-v2/src-tauri
    manifest
        .parent() // frontend-v2
        .and_then(|p| p.parent()) // repo root
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn data_dir() -> PathBuf {
    if is_packaged() {
        appdata_base().join("data")
    } else {
        repo_root().join("backend").join("data")
    }
}

pub fn output_dir() -> PathBuf {
    if is_packaged() {
        appdata_base().join("output")
    } else {
        repo_root().join("backend").join("output")
    }
}

/// The root a path handed to `open_output_folder` must sit under.
pub fn shell_base_dir() -> PathBuf {
    if is_packaged() {
        appdata_base()
    } else {
        repo_root().join("backend")
    }
}

pub fn auth_token_path() -> PathBuf {
    if is_packaged() {
        appdata_base().join("auth_token.txt")
    } else {
        repo_root().join("backend").join("auth_token.txt")
    }
}

/// Create every runtime directory the backend expects, so the first backend
/// boot finds an empty-but-present tree. Best-effort: the backend's own
/// `ensure_dirs()` is the real guarantee, this is belt-and-braces against a
/// corrupt AppData.
/// The runtime tree, relative to the base directory. One list, so the test
/// that checks these names reads the same source the creator does.
///
/// `rag/vectors-rs` is v2's vector store, **not** v1's `rag/chromadb`: this
/// host boots `backend-rs`, which writes there. Creating v1's directory left
/// v2's missing and an empty `chromadb/` behind that nothing reads.
const RUNTIME_DIRS: [&str; 8] = [
    "data",
    "output",
    "uploads",
    "logs",
    "rag",
    "rag/docs",
    "rag/vectors-rs",
    "rag/models",
];

/// The leaf name of each runtime directory, for assertions.
#[cfg(test)]
fn runtime_dir_names() -> Vec<String> {
    RUNTIME_DIRS
        .iter()
        .map(|d| d.rsplit('/').next().unwrap_or(d).to_string())
        .collect()
}

pub fn ensure_appdata_dirs() {
    let base = appdata_base();
    let _ = std::fs::create_dir_all(&base);
    for relative in RUNTIME_DIRS {
        let _ = std::fs::create_dir_all(base.join(relative));
    }
}

/// Append a line to `logs/frontend.log`. Never fails loudly — a logging
/// failure must not take down a command.
pub fn log_line(msg: &str) {
    use std::io::Write;
    let _ = std::fs::create_dir_all(appdata_logs());
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(frontend_log())
    {
        let _ = writeln!(f, "{} {}", now_iso(), msg);
    }
}

/// A timestamp good enough for a log line, without pulling in `chrono`.
fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("t+{secs}")
}

/// True when `candidate` is `base` itself or sits underneath it.
///
/// The component-wise comparison is deliberate: a plain string `starts_with`
/// lets `...\ITaxReplyAgent_evil` pass the check for base `...\ITaxReplyAgent`,
/// because the sibling shares a prefix. Comparing whole path components makes
/// that bypass impossible.
pub fn is_within(base: &Path, candidate: &Path) -> bool {
    let base = base.components().collect::<Vec<_>>();
    let cand = candidate.components().collect::<Vec<_>>();
    if cand.len() < base.len() {
        return false;
    }
    base.iter().zip(cand.iter()).all(|(a, b)| a == b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_accepts_self_and_children() {
        let base = Path::new(r"C:\Users\x\AppData\Local\ITaxReplyAgent");
        assert!(is_within(base, base));
        assert!(is_within(base, &base.join("output")));
        assert!(is_within(base, &base.join("output").join("deep")));
    }

    #[test]
    fn within_rejects_sibling_prefix_bypass() {
        let base = Path::new(r"C:\Users\x\AppData\Local\ITaxReplyAgent");
        let evil = Path::new(r"C:\Users\x\AppData\Local\ITaxReplyAgent_evil\out");
        assert!(!is_within(base, evil));
    }

    #[test]
    fn within_rejects_parent_and_unrelated() {
        let base = Path::new(r"C:\Users\x\AppData\Local\ITaxReplyAgent");
        assert!(!is_within(base, Path::new(r"C:\Users\x\AppData\Local")));
        assert!(!is_within(base, Path::new(r"D:\elsewhere")));
    }

    /// The host and the backend must agree on where the shared runtime files
    /// are, in whichever profile this is built under. They disagreed once:
    /// the config, port file and logs always resolved to AppData while the
    /// dev backend used `<repo>/backend`, so in dev Settings wrote a file
    /// nothing read and a port fallback was invisible.
    #[test]
    fn the_shared_runtime_files_sit_under_one_base() {
        let base = config_base();
        for path in [appdata_config(), appdata_port_file(), appdata_logs()] {
            assert!(
                is_within(&base, &path),
                "{} escaped the shared base {}",
                path.display(),
                base.display()
            );
        }

        // And that base follows the profile, matching backend-rs::base_dir.
        if is_packaged() {
            assert_eq!(base, appdata_base());
        } else {
            assert!(
                base.ends_with("backend"),
                "dev base should be <repo>/backend, got {}",
                base.display()
            );
        }
    }

    /// `ensure_appdata_dirs` must create v2's vector directory, not v1's.
    ///
    /// Asserted against the real directory list rather than a repeated
    /// literal, so reverting the name in the function fails this test.
    #[test]
    fn the_prepared_tree_uses_v2s_vector_directory() {
        let names = runtime_dir_names();
        assert!(
            names.iter().any(|n| n == "vectors-rs"),
            "vectors-rs missing from {names:?}"
        );
        assert!(
            !names.iter().any(|n| n == "chromadb"),
            "chromadb is v1's store and nothing here reads it: {names:?}"
        );
    }
}
