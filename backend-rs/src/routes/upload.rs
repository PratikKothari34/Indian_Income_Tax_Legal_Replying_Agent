//! `POST /upload` — persist a notice and return its extracted text.
//!
//! The saved file is the audit trail for a legal document, so two things
//! matter beyond extraction:
//!
//! * **A collision never overwrites.** Uploaded names repeat constantly —
//!   "notice.pdf", "26AS.pdf". v1 originally overwrote, which left an
//!   earlier session pointing at a file that was no longer the notice its
//!   reply was drafted from. Collisions become `name (2).pdf`.
//! * **The name is a bare basename inside the upload directory**, checked
//!   after canonicalisation, so a traversal payload cannot place a file
//!   outside it.
//!
//! Response shape matches v1 exactly: `{filename, saved_path, char_count,
//! text}`, with 400 / 413 / 415 / 500 for the failure cases. `filename` is
//! the name actually written, which differs from the uploaded one when a
//! collision was resolved.

use std::path::{Path, PathBuf};

use axum::extract::Multipart;
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;

use crate::paths;
use crate::services::parser::{self, ParseError};

/// 25 MiB. A scanned multi-page notice is large; beyond this it is not a
/// notice.
pub const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct UploadResponse {
    /// The name as written, after collision resolution.
    pub filename: String,
    pub saved_path: String,
    pub char_count: usize,
    pub text: String,
}

type Failure = (StatusCode, Json<serde_json::Value>);

fn fail(code: StatusCode, detail: impl Into<String>) -> Failure {
    (code, Json(serde_json::json!({ "detail": detail.into() })))
}

pub async fn upload_document(mut multipart: Multipart) -> Result<Json<UploadResponse>, Failure> {
    let mut filename: Option<String> = None;
    let mut data: Option<Vec<u8>> = None;

    loop {
        let field = match multipart.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => return Err(fail(StatusCode::BAD_REQUEST, format!("Malformed upload: {e}"))),
        };
        // v1's field name is `file`; anything else in the form is ignored
        // rather than rejected, so a client adding a field stays working.
        if field.name() != Some("file") {
            continue;
        }
        filename = field.file_name().map(str::to_string);
        match field.bytes().await {
            Ok(b) => data = Some(b.to_vec()),
            Err(e) => {
                return Err(fail(
                    StatusCode::BAD_REQUEST,
                    format!("Could not read the uploaded file: {e}"),
                ))
            }
        }
        break;
    }

    let Some(raw_name) = filename.filter(|n| !n.is_empty()) else {
        return Err(fail(StatusCode::BAD_REQUEST, "No filename provided."));
    };
    if raw_name.contains('\0') {
        return Err(fail(
            StatusCode::BAD_REQUEST,
            "Filename contains a null byte.",
        ));
    }
    let Some(data) = data else {
        return Err(fail(StatusCode::BAD_REQUEST, "No file part in the request."));
    };
    if data.is_empty() {
        return Err(fail(StatusCode::BAD_REQUEST, "Uploaded file is empty."));
    }
    if data.len() > MAX_UPLOAD_BYTES {
        return Err(fail(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "File exceeds the {} MiB upload limit.",
                MAX_UPLOAD_BYTES / (1024 * 1024)
            ),
        ));
    }

    // Strip every directory component before the name is used for anything.
    let safe_name = parser::safe_basename(&raw_name)
        .map_err(|e| fail(StatusCode::BAD_REQUEST, format!("Invalid filename: {e}")))?;

    // Extension gate first, so an unsupported type is a 415 before any
    // bytes are written to disk.
    let ext = parser::extension_of(&safe_name);
    let supported = parser::SUPPORTED_EXTS.contains(&ext.as_str());
    if !supported {
        let detail = if parser::OCR_ONLY_EXTS.contains(&ext.as_str()) {
            format!(
                "'{ext}' files need image OCR, which this backend does not provide. \
                 Supported: {:?}",
                parser::SUPPORTED_EXTS
            )
        } else {
            format!(
                "Unsupported file type '{ext}'. Supported: {:?}",
                parser::SUPPORTED_EXTS
            )
        };
        return Err(fail(StatusCode::UNSUPPORTED_MEDIA_TYPE, detail));
    }

    // Parse BEFORE saving. v1 saved first, which left a rejected file on
    // disk for every malformed upload. Nothing is persisted unless the
    // content is genuinely usable — and the parser's magic-byte sniff is
    // what rejects an executable renamed `.pdf`.
    let text = parser::parse_file(&safe_name, &data).map_err(|e| match e {
        ParseError::Unsupported(_) | ParseError::ContentMismatch { .. } | ParseError::PossibleXxe => {
            fail(StatusCode::UNSUPPORTED_MEDIA_TYPE, e.to_string())
        }
        ParseError::Extraction(_) => fail(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to parse file: {e}"),
        ),
    })?;

    let upload_root = paths::uploads_dir();
    std::fs::create_dir_all(&upload_root)
        .map_err(|e| fail(StatusCode::INTERNAL_SERVER_ERROR, format!("Could not create the upload directory: {e}")))?;
    // Canonicalise the root, then confirm the target stays inside it even
    // after normalisation. A component-wise check, not a string prefix: a
    // sibling directory `..._evil` passes `starts_with`.
    let canonical_root = upload_root.canonicalize().unwrap_or(upload_root.clone());
    let target = unique_path(&canonical_root.join(&safe_name));
    if !paths::is_within(&canonical_root, &target) {
        return Err(fail(StatusCode::BAD_REQUEST, "Invalid file path."));
    }

    std::fs::write(&target, &data).map_err(|e| {
        fail(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Could not save the file: {e}"),
        )
    })?;

    let written_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&safe_name)
        .to_string();
    tracing::info!(
        "upload saved {} ({} bytes, {} chars extracted)",
        written_name,
        data.len(),
        text.chars().count()
    );

    Ok(Json(UploadResponse {
        filename: written_name,
        saved_path: target.display().to_string(),
        // Characters, not bytes: the frontend shows this as a document
        // length, and a Devanagari notice is multi-byte throughout.
        char_count: text.chars().count(),
        text,
    }))
}

/// `path`, or `name (2).ext` / `name (3).ext` if taken.
///
/// Falls back to a timestamped name after 999 collisions so a pathological
/// directory cannot spin this loop.
fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let with = |name: String| -> PathBuf {
        let mut p = path.to_path_buf();
        p.set_file_name(if ext.is_empty() {
            name
        } else {
            format!("{name}.{ext}")
        });
        p
    };
    for n in 2..1000 {
        let candidate = with(format!("{stem} ({n})"));
        if !candidate.exists() {
            return candidate;
        }
    }
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S_%6f");
    with(format!("{stem}_{stamp}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_collision_never_overwrites() {
        // The saved file is the audit trail for the notice a reply cites.
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("notice.pdf");
        std::fs::write(&first, b"original").unwrap();

        let second = unique_path(&first);
        assert_ne!(second, first);
        assert_eq!(second.file_name().unwrap(), "notice (2).pdf");

        std::fs::write(&second, b"second").unwrap();
        let third = unique_path(&first);
        assert_eq!(third.file_name().unwrap(), "notice (3).pdf");
        // The original is untouched.
        assert_eq!(std::fs::read(&first).unwrap(), b"original");
    }

    #[test]
    fn a_free_name_is_used_as_is() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("fresh.pdf");
        assert_eq!(unique_path(&p), p);
    }

    #[test]
    fn traversal_payloads_cannot_escape_the_upload_directory() {
        let root = std::path::Path::new(r"C:\base\uploads");
        for payload in [
            r"..\..\backend\output\x.docx",
            "../../etc/passwd",
            r"C:\Windows\System32\evil.pdf",
        ] {
            let name = parser::safe_basename(payload).unwrap();
            assert!(!name.contains('/') && !name.contains('\\'), "{name}");
            assert!(paths::is_within(root, &root.join(name)));
        }
    }

    #[test]
    fn a_sibling_prefix_is_not_inside_the_root() {
        // The reason containment is component-wise rather than a string
        // prefix check.
        let root = std::path::Path::new(r"C:\base\uploads");
        assert!(!paths::is_within(
            root,
            std::path::Path::new(r"C:\base\uploads_evil\x.pdf")
        ));
    }
}
