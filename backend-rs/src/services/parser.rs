//! Document text extraction. Ports `backend/services/parser.py`.
//!
//! Supported: `.pdf`, `.docx`, `.xlsx`, `.xls`, and `.txt`.
//!
//! # Deliberate gap: OCR
//!
//! v1 OCRs `.jpg`/`.png` via pytesseract. There is no comparable pure-Rust
//! OCR, and shelling out to Tesseract would reintroduce the native dependency
//! this rewrite removes. Images are therefore **rejected with a clear 415**
//! rather than silently returning empty text, and the v1 backend remains the
//! path for scanned images. This is recorded as a known gap, not an oversight.
//!
//! # Why content is sniffed against the extension
//!
//! A renamed binary (`payload.exe` → `notice.pdf`) must be rejected before any
//! parser touches it. The extension alone is a client-supplied claim.

use std::io::{Cursor, Read};

use anyhow::{anyhow, Result};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("unsupported file type: {0}")]
    Unsupported(String),
    #[error("file content does not match its .{expected} extension")]
    ContentMismatch { expected: String },
    #[error("this file embeds an XML DTD or entity declaration and was rejected")]
    PossibleXxe,
    #[error("could not extract text: {0}")]
    Extraction(String),
}

pub const SUPPORTED_EXTS: [&str; 5] = ["pdf", "docx", "xlsx", "xls", "txt"];

/// Extensions v1 handles via OCR that this backend does not. Named so the
/// error can tell the user *why* rather than just "unsupported".
pub const OCR_ONLY_EXTS: [&str; 3] = ["jpg", "jpeg", "png"];

pub fn extension_of(filename: &str) -> String {
    filename
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

/// Verify the bytes look like the claimed type.
fn sniff(ext: &str, data: &[u8]) -> Result<(), ParseError> {
    let ok = match ext {
        "pdf" => data.starts_with(b"%PDF-"),
        // OOXML is a ZIP container. Accept the empty/spanned archive magics
        // too, which some writers emit.
        "docx" | "xlsx" => {
            data.starts_with(b"PK\x03\x04")
                || data.starts_with(b"PK\x05\x06")
                || data.starts_with(b"PK\x07\x08")
        }
        // Legacy OLE2 compound document.
        "xls" => data.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]),
        // Text has no magic; reject only an obvious binary (NUL in the head).
        "txt" => !data.iter().take(1024).any(|&b| b == 0),
        _ => return Err(ParseError::Unsupported(ext.to_string())),
    };
    if ok {
        Ok(())
    } else {
        Err(ParseError::ContentMismatch { expected: ext.to_string() })
    }
}

/// Reject an OOXML file that embeds a DTD or entity declaration.
///
/// `.docx`/`.xlsx` are ZIP containers of XML parts. An XXE attack smuggles a
/// `<!DOCTYPE>` / `<!ENTITY>` into one of those parts to read local files or
/// make the parser hit the network. Legitimate Office files never declare
/// either, so their presence is treated as hostile.
///
/// This is a parser-independent guard: it holds regardless of how the XML
/// reader is configured, and nothing crafted ever reaches a parser.
fn assert_no_xxe(data: &[u8]) -> Result<(), ParseError> {
    let cursor = Cursor::new(data);
    let mut zip = zip::ZipArchive::new(cursor)
        .map_err(|e| ParseError::Extraction(format!("not a readable archive: {e}")))?;
    for i in 0..zip.len() {
        let mut entry = match zip.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.name().to_ascii_lowercase();
        if !(name.ends_with(".xml") || name.ends_with(".rels")) {
            continue;
        }
        // A DOCTYPE must appear in the prolog, so the first 64 KiB is enough.
        let mut head = vec![0u8; 64 * 1024];
        let read = entry.read(&mut head).unwrap_or(0);
        let head = &head[..read];
        let text = String::from_utf8_lossy(head).to_ascii_uppercase();
        if text.contains("<!DOCTYPE") || text.contains("<!ENTITY") {
            return Err(ParseError::PossibleXxe);
        }
    }
    Ok(())
}

/// Extract plain text from a notice file.
///
/// Sheets and tables are flattened to one `" | "`-separated line per row,
/// matching v1 so the prompt builder's `# Sheet:` detection still fires.
pub fn parse_file(filename: &str, data: &[u8]) -> Result<String, ParseError> {
    let ext = extension_of(filename);
    if OCR_ONLY_EXTS.contains(&ext.as_str()) {
        return Err(ParseError::Unsupported(format!(
            "{ext} (image OCR is not available in this backend)"
        )));
    }
    if !SUPPORTED_EXTS.contains(&ext.as_str()) {
        return Err(ParseError::Unsupported(ext));
    }
    sniff(&ext, data)?;

    match ext.as_str() {
        "pdf" => parse_pdf(data),
        "docx" => {
            assert_no_xxe(data)?;
            parse_docx(data)
        }
        "xlsx" | "xls" => {
            if ext == "xlsx" {
                assert_no_xxe(data)?;
            }
            parse_spreadsheet(data)
        }
        "txt" => Ok(String::from_utf8_lossy(data).to_string()),
        other => Err(ParseError::Unsupported(other.to_string())),
    }
}

fn parse_pdf(data: &[u8]) -> Result<String, ParseError> {
    // pdf-extract panics on some malformed files rather than returning Err,
    // so the call is isolated. A corrupt upload must be a 500 with a message,
    // never a dead worker.
    let bytes = data.to_vec();
    let result = std::panic::catch_unwind(move || pdf_extract::extract_text_from_mem(&bytes));
    match result {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(e)) => Err(ParseError::Extraction(format!("PDF: {e}"))),
        Err(_) => Err(ParseError::Extraction(
            "the PDF could not be parsed (it may be corrupt or image-only)".into(),
        )),
    }
}

/// Ceiling on a single decompressed zip entry.
///
/// The 10 MiB upload cap bounds what arrives, not what it expands to. DOCX
/// is a zip, and `word/document.xml` is highly repetitive XML that deflate
/// compresses at ratios past 1000:1 -- so an upload that passes every other
/// check can still expand to gigabytes and OOM the process. 64 MiB of XML is
/// far beyond any real notice (they run to tens of kilobytes) and far below
/// what hurts.
const MAX_DECOMPRESSED_ENTRY: u64 = 64 * 1024 * 1024;

/// Ceiling on the text handed back from any one file.
///
/// Separate from [`MAX_DECOMPRESSED_ENTRY`] because the spreadsheet path
/// never sees a zip entry -- `calamine` owns the decompression -- so the only
/// place left to bound it is what comes out. A notice runs to tens of
/// kilobytes; 16 MiB of extracted text is already far past anything a model
/// could use.
const MAX_EXTRACTED_TEXT: usize = 16 * 1024 * 1024;

/// Read one zip entry to a string, refusing to decompress past
/// [`MAX_DECOMPRESSED_ENTRY`].
///
/// `Read::take` bounds the reader itself, so an oversized entry is abandoned
/// mid-stream rather than buffered and then measured.
fn read_entry_capped(entry: impl Read, what: &str) -> Result<String, ParseError> {
    let mut limited = entry.take(MAX_DECOMPRESSED_ENTRY + 1);
    let mut buf = String::new();
    limited
        .read_to_string(&mut buf)
        .map_err(|e| ParseError::Extraction(format!("{what}: {e}")))?;
    if buf.len() as u64 > MAX_DECOMPRESSED_ENTRY {
        return Err(ParseError::Extraction(format!(
            "{what}: decompressed content exceeds the {} MiB limit",
            MAX_DECOMPRESSED_ENTRY / (1024 * 1024)
        )));
    }
    Ok(buf)
}

/// Pull paragraph and table text out of `word/document.xml`.
fn parse_docx(data: &[u8]) -> Result<String, ParseError> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let cursor = Cursor::new(data);
    let mut zip = zip::ZipArchive::new(cursor)
        .map_err(|e| ParseError::Extraction(format!("DOCX: {e}")))?;
    let entry = zip
        .by_name("word/document.xml")
        .map_err(|_| ParseError::Extraction("DOCX: no word/document.xml".into()))?;
    let xml = read_entry_capped(entry, "DOCX")?;

    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(false);
    let mut out = String::new();
    let mut line = String::new();
    let mut in_text = false;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.name();
                let local = name.local_name();
                match local.as_ref() {
                    b"t" => in_text = true,
                    b"tab" => line.push('\t'),
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let name = e.name();
                match name.local_name().as_ref() {
                    b"br" | b"cr" => line.push('\n'),
                    b"tab" => line.push('\t'),
                    _ => {}
                }
            }
            Ok(Event::Text(t)) if in_text => {
                line.push_str(&t.unescape().unwrap_or_default());
            }
            Ok(Event::End(e)) => {
                let name = e.name();
                match name.local_name().as_ref() {
                    b"t" => in_text = false,
                    // End of paragraph or table cell: flush a line.
                    b"p" => {
                        out.push_str(line.trim_end());
                        out.push('\n');
                        line.clear();
                    }
                    b"tc" => {
                        if !line.trim().is_empty() {
                            out.push_str(line.trim());
                            out.push_str(" | ");
                            line.clear();
                        }
                    }
                    b"tr" => {
                        let trimmed = out.trim_end().trim_end_matches('|').trim_end().to_string();
                        out = trimmed;
                        out.push('\n');
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(ParseError::Extraction(format!("DOCX XML: {e}"))),
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

/// Flatten every sheet to `# Sheet: <name>` plus `" | "`-joined rows.
///
/// The `# Sheet:` prefix is a contract with `prompts.rs`, which uses it to
/// relabel the input as financial data rather than a notice body.
fn parse_spreadsheet(data: &[u8]) -> Result<String, ParseError> {
    use calamine::{Data, Reader};

    let cursor = Cursor::new(data.to_vec());
    let mut workbook = calamine::open_workbook_auto_from_rs(cursor)
        .map_err(|e| ParseError::Extraction(format!("spreadsheet: {e}")))?;

    let mut out = String::new();
    for name in workbook.sheet_names().to_vec() {
        let range = match workbook.worksheet_range(&name) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("skipping sheet {name}: {e}");
                continue;
            }
        };
        out.push_str(&format!("# Sheet: {name}\n"));
        for row in range.rows() {
            // calamine decompresses internally, so the entry cap in
            // `read_entry_capped` cannot reach it. Bounding what is
            // accumulated is the backstop: a sheet claiming millions of
            // rows stops costing memory here.
            if out.len() > MAX_EXTRACTED_TEXT {
                return Err(ParseError::Extraction(format!(
                    "spreadsheet: extracted text exceeds the {} MiB limit",
                    MAX_EXTRACTED_TEXT / (1024 * 1024)
                )));
            }
            let cells: Vec<String> = row
                .iter()
                .map(|cell| match cell {
                    Data::Empty => String::new(),
                    Data::String(s) => s.trim().to_string(),
                    Data::Float(f) => {
                        // Render whole floats without a trailing .0 so a
                        // figure reads as "85000", not "85000.0".
                        if f.fract() == 0.0 && f.abs() < 1e15 {
                            format!("{}", *f as i64)
                        } else {
                            f.to_string()
                        }
                    }
                    Data::Int(i) => i.to_string(),
                    Data::Bool(b) => b.to_string(),
                    Data::DateTime(d) => d.to_string(),
                    Data::DateTimeIso(s) => s.clone(),
                    Data::DurationIso(s) => s.clone(),
                    Data::Error(e) => format!("#ERR:{e:?}"),
                })
                .collect();
            if cells.iter().all(|c| c.is_empty()) {
                continue;
            }
            out.push_str(&cells.join(" | "));
            out.push('\n');
        }
        out.push('\n');
    }
    Ok(out)
}

/// Reduce a client-supplied filename to a safe basename.
///
/// Strips every path component, rejects NUL, and collapses anything outside a
/// conservative set. A traversal payload or absolute path cannot survive this.
pub fn safe_basename(filename: &str) -> Result<String> {
    if filename.contains('\0') {
        return Err(anyhow!("filename contains a null byte"));
    }
    let base = filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    if base.is_empty() || base == "." || base == ".." {
        return Err(anyhow!("filename is missing or invalid"));
    }
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ' | '(' | ')') {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Windows reserves these names regardless of extension.
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
        "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6",
        "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        return Ok(format!("file_{cleaned}"));
    }
    Ok(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_rejects_renamed_binary() {
        // An .exe renamed to .pdf must never reach a parser.
        let mz = b"MZ\x90\x00\x03";
        assert!(matches!(
            sniff("pdf", mz),
            Err(ParseError::ContentMismatch { .. })
        ));
    }

    #[test]
    fn sniff_accepts_real_magics() {
        assert!(sniff("pdf", b"%PDF-1.7\n").is_ok());
        assert!(sniff("docx", b"PK\x03\x04rest").is_ok());
        assert!(sniff("xls", &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00]).is_ok());
        assert!(sniff("txt", b"plain notice text").is_ok());
    }

    #[test]
    fn sniff_rejects_binary_masquerading_as_text() {
        assert!(sniff("txt", b"ab\0cd").is_err());
    }

    #[test]
    fn images_are_rejected_with_an_explanation() {
        let err = parse_file("scan.png", b"\x89PNG\r\n\x1a\n").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("OCR"), "error must say why: {msg}");
    }

    #[test]
    fn unknown_extension_is_rejected() {
        assert!(matches!(
            parse_file("notice.exe", b"MZ"),
            Err(ParseError::Unsupported(_))
        ));
        assert!(matches!(
            parse_file("noextension", b"data"),
            Err(ParseError::Unsupported(_))
        ));
    }

    #[test]
    fn basename_defeats_traversal() {
        assert_eq!(safe_basename(r"..\..\..\windows\system32\evil.pdf").unwrap(), "evil.pdf");
        assert_eq!(safe_basename("../../etc/passwd").unwrap(), "passwd");
        assert_eq!(safe_basename(r"C:\Users\x\notice.pdf").unwrap(), "notice.pdf");
    }

    #[test]
    fn basename_rejects_null_and_empty() {
        assert!(safe_basename("a\0b.pdf").is_err());
        assert!(safe_basename("   ").is_err());
        assert!(safe_basename("..").is_err());
        assert!(safe_basename("/").is_err());
    }

    #[test]
    fn basename_neutralises_reserved_device_names() {
        assert_eq!(safe_basename("CON.pdf").unwrap(), "file_CON.pdf");
        assert_eq!(safe_basename("nul.txt").unwrap(), "file_nul.txt");
    }

    #[test]
    fn basename_sanitises_shell_metacharacters() {
        let out = safe_basename("notice;rm -rf *.pdf").unwrap();
        assert!(!out.contains(';'));
        assert!(!out.contains('*'));
    }

    #[test]
    fn xxe_guard_rejects_doctype_in_an_ooxml_part() {
        // Build a minimal zip whose document.xml declares a DOCTYPE.
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<'_, ()> =
                zip::write::FileOptions::default();
            use std::io::Write;
            zw.start_file("word/document.xml", opts).unwrap();
            zw.write_all(
                br#"<?xml version="1.0"?><!DOCTYPE f [<!ENTITY x SYSTEM "file:///c:/config.json">]><w:document>&x;</w:document>"#,
            )
            .unwrap();
            zw.finish().unwrap();
        }
        assert!(matches!(assert_no_xxe(&buf), Err(ParseError::PossibleXxe)));
        assert!(matches!(
            parse_file("notice.docx", &buf),
            Err(ParseError::PossibleXxe)
        ));
    }

    /// Build a one-entry DOCX whose `word/document.xml` decompresses to
    /// `repeats` copies of a short, highly compressible run.
    fn docx_with_document_xml_of(repeats: usize) -> Vec<u8> {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            w.start_file("word/document.xml", opts).expect("entry");
            // No DOCTYPE/ENTITY, so the XXE guard passes and the read is
            // what has to stop this.
            w.write_all(b"<w:document><w:body>").expect("head");
            let run = b"<w:p><w:r><w:t>AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA</w:t></w:r></w:p>";
            for _ in 0..repeats {
                w.write_all(run).expect("run");
            }
            w.write_all(b"</w:body></w:document>").expect("tail");
            w.finish().expect("finish");
        }
        buf
    }

    #[test]
    fn a_small_docx_still_parses() {
        // The cap must not break ordinary files: this is a real notice's
        // order of magnitude.
        let data = docx_with_document_xml_of(200);
        let text = parse_file("notice.docx", &data).expect("should parse");
        assert!(text.contains("AAAA"), "text was not extracted");
    }

    #[test]
    fn a_zip_bomb_is_refused_rather_than_buffered() {
        // The 10 MiB upload cap bounds the compressed bytes, not the
        // decompressed ones. This archive is a few hundred KiB on the wire
        // and expands past the 64 MiB entry ceiling; without the cap the
        // whole expansion lands in memory.
        let run_len = 52; // bytes per repeat, see above
        let repeats = (MAX_DECOMPRESSED_ENTRY as usize / run_len) + 5_000;
        let data = docx_with_document_xml_of(repeats);

        assert!(
            data.len() < 10 * 1024 * 1024,
            "the bomb must fit under the upload cap to be a real case; was {} bytes",
            data.len()
        );

        match parse_file("notice.docx", &data) {
            Err(ParseError::Extraction(msg)) => {
                assert!(msg.contains("exceeds"), "wrong error: {msg}");
            }
            other => panic!("expected the entry cap to reject it, got {other:?}"),
        }
    }

    #[test]
    fn xxe_guard_allows_a_clean_ooxml_part() {
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<'_, ()> =
                zip::write::FileOptions::default();
            use std::io::Write;
            zw.start_file("word/document.xml", opts).unwrap();
            zw.write_all(br#"<?xml version="1.0"?><w:document><w:p><w:r><w:t>Notice u/s 143(2)</w:t></w:r></w:p></w:document>"#).unwrap();
            zw.finish().unwrap();
        }
        assert!(assert_no_xxe(&buf).is_ok());
        let text = parse_file("notice.docx", &buf).unwrap();
        assert!(text.contains("143(2)"), "got {text:?}");
    }
}
