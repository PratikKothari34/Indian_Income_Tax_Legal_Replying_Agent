//! Render a model reply to a print-clean `.docx`. Ports
//! `backend/services/docx_writer.py`.
//!
//! # Why the OOXML is written by hand
//!
//! v1 uses `python-docx`. The Rust ecosystem's equivalents either pull a
//! heavy dependency tree or do not expose run-level bold/italic the way this
//! needs. A `.docx` is a ZIP of five small XML parts, and this module only
//! ever produces paragraphs with bold/italic runs and a bullet style — so the
//! parts are emitted directly. That keeps the dependency to `zip`, which the
//! parser already needs, and makes the output byte-deterministic.
//!
//! # The Markdown problem this solves
//!
//! Instruction-tuned models return Markdown-flavoured prose: `**bold**`,
//! `*italic*`, `# Heading`, `- item`. Writing that text verbatim into Word
//! leaves literal asterisks on a formal legal letter. Every marker is
//! therefore converted to real Word formatting and removed from the text.
//!
//! Font is Times New Roman 12pt — the de-facto standard for Indian legal
//! correspondence.

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::Local;

use crate::paths;

/// One formatted span within a paragraph.
#[derive(Debug, PartialEq, Eq)]
struct Run {
    text: String,
    bold: bool,
    italic: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Block {
    /// Empty line; preserved so the reply keeps its visual spacing.
    Blank,
    /// Bold paragraph at 14/13/12pt depending on heading level.
    Heading { level: u8, text: String },
    Bullet(Vec<Run>),
    Paragraph(Vec<Run>),
}

/// Escape the five XML entities. Must run on every piece of model text —
/// a reply quoting `<Annexure A>` or `M/s Sharma & Co.` otherwise produces a
/// file Word refuses to open.
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Control characters are illegal in XML 1.0 and will not open.
            c if (c as u32) < 0x20 && c != '\t' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// Split a line into bold/italic runs, stripping the markers.
///
/// Bold is matched first so `**foo**` is not mis-read as `*` + `foo` + `*`.
/// Matching is non-greedy, so two emphasised spans on one line stay separate.
fn parse_inline(text: &str) -> Vec<Run> {
    let chars: Vec<char> = text.chars().collect();
    let mut runs: Vec<Run> = Vec::new();
    let mut plain = String::new();
    let mut i = 0;

    // Find the closing delimiter for an emphasis span opened at `from`.
    // Returns the index of its first character.
    fn find_close(chars: &[char], from: usize, marker_len: usize) -> Option<usize> {
        let mut j = from;
        while j + marker_len <= chars.len() {
            let is_marker = chars[j..j + marker_len].iter().all(|&c| c == '*');
            // For italic, a lone `*` must not be part of a `**`.
            let bounded = if marker_len == 1 {
                chars.get(j + 1).copied() != Some('*')
            } else {
                true
            };
            if is_marker && bounded && j > from {
                return Some(j);
            }
            j += 1;
        }
        None
    }

    let flush = |plain: &mut String, runs: &mut Vec<Run>| {
        if !plain.is_empty() {
            runs.push(Run { text: std::mem::take(plain), bold: false, italic: false });
        }
    };

    while i < chars.len() {
        let is_bold_open = chars[i] == '*' && chars.get(i + 1).copied() == Some('*');
        if is_bold_open {
            if let Some(close) = find_close(&chars, i + 2, 2) {
                let inner: String = chars[i + 2..close].iter().collect();
                if !inner.trim().is_empty() {
                    flush(&mut plain, &mut runs);
                    runs.push(Run { text: inner, bold: true, italic: false });
                    i = close + 2;
                    continue;
                }
            }
        } else if chars[i] == '*' {
            // Italic: the opener must not be followed by whitespace, matching
            // v1's regex, so a literal asterisk in prose stays literal.
            let next_ok = chars.get(i + 1).map(|c| !c.is_whitespace()).unwrap_or(false);
            if next_ok {
                if let Some(close) = find_close(&chars, i + 1, 1) {
                    let inner: String = chars[i + 1..close].iter().collect();
                    if !inner.trim().is_empty() && !inner.ends_with(char::is_whitespace) {
                        flush(&mut plain, &mut runs);
                        runs.push(Run { text: inner, bold: false, italic: true });
                        i = close + 1;
                        continue;
                    }
                }
            }
        }
        plain.push(chars[i]);
        i += 1;
    }
    flush(&mut plain, &mut runs);
    runs
}

/// Classify one line of model output.
fn parse_line(raw: &str) -> Block {
    let line = raw.trim_end();
    if line.trim().is_empty() {
        return Block::Blank;
    }
    let trimmed = line.trim_start();

    // ATX heading: `# H1` ... `###### H6`, with optional closing hashes.
    let hashes = trimmed.chars().take_while(|&c| c == '#').count();
    if (1..=6).contains(&hashes) && trimmed.chars().nth(hashes) == Some(' ') {
        let body = trimmed[hashes + 1..].trim().trim_end_matches('#').trim();
        return Block::Heading { level: hashes as u8, text: body.to_string() };
    }

    // Whole-line bold heading: `**Subject:**`
    if let Some(inner) = trimmed
        .strip_prefix("**")
        .and_then(|s| s.strip_suffix("**"))
    {
        if !inner.trim().is_empty() && !inner.contains("**") {
            return Block::Heading { level: 3, text: inner.trim().to_string() };
        }
    }

    // List bullet: `- foo`, `* foo`, `+ foo`. The trailing space is required
    // so `*italic*` at line start is not mis-stripped.
    let bullet = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("+ "));
    if let Some(body) = bullet {
        return Block::Bullet(parse_inline(body.trim_start()));
    }

    Block::Paragraph(parse_inline(line))
}

fn runs_to_xml(runs: &[Run]) -> String {
    let mut out = String::new();
    for run in runs {
        let mut props = String::new();
        if run.bold {
            props.push_str("<w:b/>");
        }
        if run.italic {
            props.push_str("<w:i/>");
        }
        let props = if props.is_empty() {
            String::new()
        } else {
            format!("<w:rPr>{props}</w:rPr>")
        };
        out.push_str(&format!(
            // xml:space="preserve" keeps the leading/trailing spaces that
            // separate an emphasised span from the words around it.
            r#"<w:r>{props}<w:t xml:space="preserve">{}</w:t></w:r>"#,
            xml_escape(&run.text)
        ));
    }
    out
}

fn block_to_xml(block: &Block) -> String {
    match block {
        Block::Blank => "<w:p/>".to_string(),
        Block::Heading { level, text } => {
            // Half-points: 14pt -> 28, 13pt -> 26, 12pt -> 24.
            let half_pt = match level {
                1 => 28,
                2 => 26,
                _ => 24,
            };
            format!(
                r#"<w:p><w:r><w:rPr><w:b/><w:sz w:val="{half_pt}"/><w:szCs w:val="{half_pt}"/></w:rPr><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
                xml_escape(text)
            )
        }
        Block::Bullet(runs) => format!(
            r#"<w:p><w:pPr><w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>{}</w:p>"#,
            runs_to_xml(runs)
        ),
        Block::Paragraph(runs) => format!("<w:p>{}</w:p>", runs_to_xml(runs)),
    }
}

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>"#;

const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

const DOC_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>"#;

/// Normal = Times New Roman 12pt; ListBullet for bulleted lines.
const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:hanging="360"/><w:spacing w:after="60"/></w:pPr></w:style></w:styles>"#;

/// A single bullet list definition, referenced as numId 1.
const NUMBERING: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>"#;

/// Build the complete `.docx` bytes for a reply.
///
/// Exposed separately from the file write so it can be unit-tested and so a
/// future route can stream the document without touching disk.
pub fn render_docx(reply_text: &str) -> Result<Vec<u8>> {
    let body: String = reply_text
        .lines()
        .map(|line| block_to_xml(&parse_line(line)))
        .collect();

    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    );

    let mut buf = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        // [Content_Types].xml must be the first entry.
        for (name, content) in [
            ("[Content_Types].xml", CONTENT_TYPES),
            ("_rels/.rels", ROOT_RELS),
            ("word/_rels/document.xml.rels", DOC_RELS),
            ("word/styles.xml", STYLES),
            ("word/numbering.xml", NUMBERING),
            ("word/document.xml", document.as_str()),
        ] {
            zw.start_file(name, opts)?;
            zw.write_all(content.as_bytes())?;
        }
        zw.finish()?;
    }
    Ok(buf)
}

/// Write a timestamped `.docx` under `output/` and return its path.
///
/// The filename carries a second-resolution timestamp, matching v1 so the
/// frontend's output list sorts identically across both backends.
pub fn save_reply_docx(reply_text: &str, prefix: &str) -> Result<PathBuf> {
    let dir = paths::output_dir();
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("could not create {}", dir.display()))?;

    // The prefix reaches here from a request body. Reduce it to a safe stem
    // so it cannot escape output/ or inject a path separator.
    let prefix = sanitise_prefix(prefix);
    let stamp = Local::now().format("%Y%m%d_%H%M%S");
    let mut path = dir.join(format!("{prefix}_{stamp}.docx"));

    // Two generations within the same second must not clobber each other.
    let mut n = 2;
    while path.exists() && n < 100 {
        path = dir.join(format!("{prefix}_{stamp}_{n}.docx"));
        n += 1;
    }

    debug_assert!(paths::is_within(&dir, &path));
    let bytes = render_docx(reply_text)?;
    std::fs::write(&path, bytes)
        .with_context(|| format!("could not write {}", path.display()))?;
    Ok(path)
}

fn sanitise_prefix(prefix: &str) -> String {
    let cleaned: String = prefix
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "ITax_Reply".to_string()
    } else {
        cleaned
    }
}

/// List previously generated outputs, newest first.
pub fn list_outputs() -> Vec<(String, PathBuf, u64)> {
    let dir = paths::output_dir();
    let mut rows: Vec<(String, PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("docx") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        rows.push((name, path, meta.len(), mtime));
    }
    rows.sort_by(|a, b| b.3.cmp(&a.3));
    rows.into_iter().map(|(n, p, s, _)| (n, p, s)).collect()
}

/// Resolve a client-supplied output filename to a real path inside `output/`.
///
/// Containment is checked component-wise after canonicalisation — a prefix
/// comparison would accept a sibling directory whose name merely starts with
/// the output path.
pub fn resolve_output(filename: &str) -> Option<PathBuf> {
    let dir = paths::output_dir();
    let base = Path::new(filename).file_name()?;
    let candidate = dir.join(base);
    let real = candidate.canonicalize().ok()?;
    let real_dir = dir.canonicalize().ok()?;
    if paths::is_within(&real_dir, &real) && real.is_file() {
        Some(real)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(text: &str) -> Run {
        Run { text: text.to_string(), bold: false, italic: false }
    }

    #[test]
    fn bold_markers_become_runs_and_disappear() {
        let runs = parse_inline("Reply to **Notice u/s 143(2)** today");
        assert_eq!(
            runs,
            vec![
                plain("Reply to "),
                Run { text: "Notice u/s 143(2)".into(), bold: true, italic: false },
                plain(" today"),
            ]
        );
        // No asterisk may survive into the document.
        assert!(!runs.iter().any(|r| r.text.contains('*')));
    }

    #[test]
    fn two_bold_spans_on_one_line_stay_separate() {
        let runs = parse_inline("**A** mid **B**");
        let bolds: Vec<&str> = runs
            .iter()
            .filter(|r| r.bold)
            .map(|r| r.text.as_str())
            .collect();
        assert_eq!(bolds, vec!["A", "B"]);
    }

    #[test]
    fn italic_is_not_confused_with_bold() {
        let runs = parse_inline("*suo motu* revision");
        assert!(runs[0].italic && !runs[0].bold);
        assert_eq!(runs[0].text, "suo motu");
    }

    #[test]
    fn a_lone_asterisk_stays_literal() {
        let runs = parse_inline("Rate is 10% * the base");
        let joined: String = runs.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(joined, "Rate is 10% * the base");
    }

    #[test]
    fn atx_headings_map_to_sizes() {
        assert_eq!(
            parse_line("# Grounds of Objection"),
            Block::Heading { level: 1, text: "Grounds of Objection".into() }
        );
        assert_eq!(
            parse_line("## Facts"),
            Block::Heading { level: 2, text: "Facts".into() }
        );
        // Closing hashes are stripped too.
        assert_eq!(
            parse_line("## Facts ##"),
            Block::Heading { level: 2, text: "Facts".into() }
        );
        // A hash without a following space is prose, not a heading.
        assert!(matches!(parse_line("#1 objection"), Block::Paragraph(_)));
    }

    #[test]
    fn whole_line_bold_is_a_heading() {
        assert_eq!(
            parse_line("**Subject:**"),
            Block::Heading { level: 3, text: "Subject:".into() }
        );
    }

    #[test]
    fn bullets_lose_their_marker() {
        match parse_line("- The notice is time-barred") {
            Block::Bullet(runs) => {
                assert_eq!(runs[0].text, "The notice is time-barred");
            }
            other => panic!("expected a bullet, got {other:?}"),
        }
        assert!(matches!(parse_line("* item"), Block::Bullet(_)));
        assert!(matches!(parse_line("+ item"), Block::Bullet(_)));
        // `*italic*` at line start is emphasis, not a bullet.
        assert!(matches!(parse_line("*emphasis* here"), Block::Paragraph(_)));
    }

    #[test]
    fn blank_lines_are_preserved() {
        assert_eq!(parse_line(""), Block::Blank);
        assert_eq!(parse_line("   "), Block::Blank);
    }

    #[test]
    fn xml_special_characters_are_escaped() {
        // A reply quoting "M/s Sharma & Co." or "<Annexure A>" must still
        // produce a file Word can open.
        let bytes = render_docx("M/s Sharma & Co. filed <Annexure A> \"on time\"").unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut xml = String::new();
        use std::io::Read;
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("&amp;"), "ampersand must be escaped");
        assert!(xml.contains("&lt;Annexure A&gt;"));
        // A raw & or a bare < from the content would break the part.
        assert!(!xml.contains("& Co."));
    }

    #[test]
    fn the_package_has_every_required_part() {
        let bytes = render_docx("# Reply\n\nBody text.").unwrap();
        let zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let names: Vec<String> = zip.file_names().map(str::to_string).collect();
        for required in [
            "[Content_Types].xml",
            "_rels/.rels",
            "word/document.xml",
            "word/styles.xml",
            "word/numbering.xml",
            "word/_rels/document.xml.rels",
        ] {
            assert!(names.iter().any(|n| n == required), "missing {required}");
        }
        // Word requires [Content_Types].xml first in the archive.
        assert_eq!(names[0], "[Content_Types].xml");
    }

    #[test]
    fn font_is_times_new_roman_12pt() {
        let bytes = render_docx("x").unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut xml = String::new();
        use std::io::Read;
        zip.by_name("word/styles.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("Times New Roman"));
        assert!(xml.contains(r#"w:sz w:val="24""#), "12pt == 24 half-points");
    }

    #[test]
    fn prefix_cannot_escape_the_output_directory() {
        assert_eq!(sanitise_prefix("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitise_prefix(r"..\..\config"), "config");
        assert_eq!(sanitise_prefix(""), "ITax_Reply");
        assert_eq!(sanitise_prefix("///"), "ITax_Reply");
        assert!(!sanitise_prefix("a/b\\c:d").contains('/'));
    }

    #[test]
    fn control_characters_do_not_break_the_xml() {
        let bytes = render_docx("bad \u{0007} bell").unwrap();
        assert!(!bytes.is_empty());
    }
}
