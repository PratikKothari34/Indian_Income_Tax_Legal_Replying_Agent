//! Corpus acquisition. Ports `backend/services/rag_scraper.py`.
//!
//! Two ingestion paths feed one pipeline:
//!
//! 1. **Manual drop folder** — `rag/documents/` is scanned recursively for
//!    user-supplied PDF / DOCX / TXT.
//! 2. **Indian Kanoon REST API** — a handful of searches, then metadata +
//!    full text per new document, stripped to `.txt` under
//!    `rag/documents/<doc_type>/`, which the manual path then picks up.
//!
//! An earlier v1 iteration tried headless-Chromium scraping of
//! `incometaxindia.gov.in`; every request was rejected at Akamai's edge with
//! 403. Indian Kanoon is the working surface for the same material. The
//! direct-PDF probe under `/news/` survives behind a config flag and is
//! **off by default** — it costs up to ~400 requests to one host per sync.
//!
//! # Dedup is the thing that makes a sync cheap
//!
//! Every document, local or remote, is reduced to a stable key held in
//! `known_urls` inside `sync_status-rs.json`. A local file keys on
//! `sha256(name|size|mtime)`; a remote one on `sha256(public_url)`. Without
//! this a nightly sync would re-download and re-embed the whole corpus.
//!
//! # Outbound hosts
//!
//! This module is why the product is **not** "fully offline": it reaches
//! `api.indiankanoon.org`, and optionally `incometaxindia.gov.in`.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;
use chrono::{Datelike, NaiveDate, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

use super::rag_embedder::PdfMeta;
use crate::config::AppConfig;
use crate::paths;

pub const SUPPORTED_EXTS: [&str; 3] = ["pdf", "docx", "txt"];

const IK_API_BASE: &str = "https://api.indiankanoon.org";
const IK_SEARCH_URL: &str = "https://api.indiankanoon.org/search/";
const IK_PUBLIC_URL_PREFIX: &str = "https://indiankanoon.org/doc/";

/// 5 pages x 10 rows gives 50 candidates per query before dedup.
const IK_SEARCH_PAGES: [u32; 5] = [0, 1, 2, 3, 4];

/// `doctypes:laws` plus a Union-of-India docsource still surfaces unrelated
/// statutes (Waqf Amendment Act, RERA). Requiring one of these in the title
/// narrows the keep-set to direct-tax material.
const IK_TITLE_KEYWORDS: [&str; 9] = [
    "income tax",
    "income-tax",
    "finance act",
    "direct tax",
    "cbdt",
    "tds",
    "tcs",
    "capital gains",
    "assessment",
];

const MAX_NEW_DOWNLOADS_PER_SYNC: usize = 100;

/// Polite spacing between API calls.
const API_DELAY: Duration = Duration::from_millis(500);
const IK_TIMEOUT: Duration = Duration::from_secs(60);

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ITaxReplyAgent/1.0";

/// Documents whose age never disqualifies them.
///
/// Indian Kanoon stamps a statute with the year its parent Act was passed
/// (1961 for the IT Act), but the sections remain current law until
/// explicitly repealed. Dropping them by age would gut the index.
const NEVER_EXPIRE_DOC_TYPES: [&str; 3] =
    ["income_tax_act", "income_tax_rules", "finance_act"];

const DEFAULT_AGE_LIMIT_DAYS: i64 = 365 * 3;

fn age_limit_days(doc_type: &str) -> i64 {
    match doc_type {
        "circular" | "notification" | "press_release" => 365 * 3,
        // Generic CBDT material goes stale fastest.
        "cbdt_general" => 365 * 2,
        _ => DEFAULT_AGE_LIMIT_DAYS,
    }
}

/// Older slug, newer slug. The embedder marks the older one superseded once
/// both are indexed. Matched case-insensitively against `source_url`.
pub const SUPERSESSION_PAIRS: [(&str, &str); 2] = [
    ("income-tax-act-1961", "income-tax-act-20251"),
    ("income-tax-rules-1962", "income-tax-rule-2026"),
];

// --- dedup state -----------------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SyncStatus {
    #[serde(default)]
    pub known_urls: Vec<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

/// Dedup key for a locally-dropped file: name, size and mtime.
///
/// Content-addressing the whole file would be stronger but means reading
/// every PDF in the corpus on every sync. Name+size+mtime changes whenever
/// the user replaces a file, which is the case that matters.
fn file_key(path: &Path) -> String {
    let sig = match std::fs::metadata(path) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!(
                "{}|{}|{}",
                path.file_name().and_then(|n| n.to_str()).unwrap_or(""),
                m.len(),
                mtime
            )
        }
        Err(_) => path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string(),
    };
    sha256_hex(&sig)
}

fn url_hash(url: &str) -> String {
    sha256_hex(url.trim())
}

pub fn load_known_urls() -> BTreeSet<String> {
    let path = paths::rag_sync_status();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return BTreeSet::new();
    };
    match serde_json::from_str::<SyncStatus>(&text) {
        Ok(status) => status.known_urls.into_iter().collect(),
        Err(e) => {
            tracing::warn!("sync status unreadable ({e}); treating dedup set as empty");
            BTreeSet::new()
        }
    }
}

/// Persist `known`, merging any other keys already in the file.
///
/// Written to a uniquely-named temporary and renamed, because the scheduler
/// writes this same file and a reindex can remove it mid-sync.
pub fn save_known_urls(
    known: &BTreeSet<String>,
    extra: Option<HashMap<String, serde_json::Value>>,
) -> Result<()> {
    let path = paths::rag_sync_status();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut current: HashMap<String, serde_json::Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    current.insert(
        "known_urls".into(),
        serde_json::to_value(known.iter().collect::<Vec<_>>())?,
    );
    if let Some(extra) = extra {
        current.extend(extra);
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec_pretty(&current)?)?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

// --- classification --------------------------------------------------------

static WS_RE: OnceLock<Regex> = OnceLock::new();
static YEAR_RE: OnceLock<Regex> = OnceLock::new();
static HTML_TAG_RE: OnceLock<Regex> = OnceLock::new();

fn collapse_ws(s: &str) -> String {
    let re = WS_RE.get_or_init(|| Regex::new(r"\s+").expect("ws regex"));
    re.replace_all(s, " ").trim().to_string()
}

/// Guess a document type from a filename stem.
pub fn classify_doc_type(path: &Path) -> String {
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if name.contains("press") && (name.contains("release") || name.contains("_pr_")) {
        return "press_release".into();
    }
    if name.contains("circular") {
        return "circular".into();
    }
    if name.contains("notification") {
        return "notification".into();
    }
    if name.contains("finance") {
        return "finance_act".into();
    }
    if name.contains("income-tax-act") || name.contains("income_tax_act") {
        return "income_tax_act".into();
    }
    if name.contains("rule") {
        return "income_tax_rules".into();
    }
    "unknown".into()
}

/// Bucket an Indian Kanoon document by its title.
///
/// Order matters: the specific Act/Rules signals come first so
/// "Section 80C in The Income Tax Act, 1961" buckets as `income_tax_act`.
/// The title is whitespace-collapsed first — IK section titles routinely
/// look like "The  Income   Tax   Act, 2025", which would otherwise defeat
/// the "income tax act" literal.
pub fn classify_ik_title(title: &str) -> String {
    let t = collapse_ws(&title.to_lowercase());
    if t.contains("income tax act") || t.contains("income-tax act") {
        return "income_tax_act".into();
    }
    if t.contains("income tax rules") || t.contains("income-tax rules") {
        return "income_tax_rules".into();
    }
    if t.contains("finance act") {
        return "finance_act".into();
    }
    if t.contains("circular") {
        return "circular".into();
    }
    if t.contains("notification") {
        return "notification".into();
    }
    "cbdt_general".into()
}

fn parse_effective_date(text: &str) -> String {
    let re = YEAR_RE.get_or_init(|| Regex::new(r"(19|20)\d{2}").expect("year regex"));
    match re.find(text) {
        Some(m) => format!("{}-01-01", m.as_str()),
        None => String::new(),
    }
}

/// True when `iso_date` is past the freshness limit for `doc_type`.
///
/// An undated document is allowed through: without a date freshness cannot
/// be judged, and dropping every undated row discards good results.
fn is_too_old(doc_type: &str, iso_date: &str) -> bool {
    if NEVER_EXPIRE_DOC_TYPES.contains(&doc_type) {
        return false;
    }
    if iso_date.is_empty() {
        return false;
    }
    let Ok(published) = NaiveDate::parse_from_str(&iso_date[..iso_date.len().min(10)], "%Y-%m-%d")
    else {
        return false;
    };
    let age = (Utc::now().date_naive() - published).num_days();
    age > age_limit_days(doc_type)
}

// --- HTML handling ---------------------------------------------------------

/// Strip inline markup from a short string (a title, a headline).
///
/// IK wraps matched terms in `<b>` tags inside `title`, so without this the
/// corpus ends up with filenames and metadata like
/// `<b>Income</b><b>Tax</b>...`.
pub fn strip_html_tags(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let re = HTML_TAG_RE.get_or_init(|| Regex::new(r"<[^>]+>").expect("tag regex"));
    decode_entities(&collapse_ws(&re.replace_all(text, " ")))
}

/// Convert IK's HTML document payload to readable plain text.
pub fn strip_html_to_text(html: &str) -> String {
    if html.is_empty() {
        return String::new();
    }
    use scraper::{Html, Selector};
    let doc = Html::parse_document(html);
    // Script and style content is not prose and must never be embedded.
    let drop = Selector::parse("script, style").expect("drop selector");
    let dropped: Vec<_> = doc.select(&drop).map(|e| e.id()).collect();
    let mut lines: Vec<String> = Vec::new();
    for node in doc.tree.nodes() {
        if let Some(text) = node.value().as_text() {
            // Skip text inside a dropped element.
            let inside = node
                .ancestors()
                .any(|a| dropped.contains(&a.id()));
            if inside {
                continue;
            }
            let t = text.trim();
            if !t.is_empty() {
                lines.push(collapse_ws(t));
            }
        }
    }
    let joined = lines.join("\n");
    // Collapse runs of blank lines to exactly one, matching v1's output so
    // the paragraph-aware chunker sees the same boundaries.
    let mut out = String::with_capacity(joined.len());
    let mut blanks = 0;
    for line in joined.lines() {
        if line.trim().is_empty() {
            blanks += 1;
            if blanks > 1 {
                continue;
            }
        } else {
            blanks = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

/// Decode the entities IK's payloads actually contain. `&amp;` is decoded
/// last so `&amp;lt;` does not become `<`.
fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Filesystem-safe stub for a filename component.
pub fn sanitise_filename_part(s: &str, max_len: usize) -> String {
    let mut out = String::new();
    let mut last_underscore = false;
    for c in s.trim().chars() {
        if c.is_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
            last_underscore = c == '_';
        } else if !last_underscore {
            out.push('_');
            last_underscore = true;
        }
    }
    let trimmed: String = out.trim_matches(|c| c == '.' || c == '_' || c == '-').to_string();
    let capped: String = trimmed.chars().take(max_len).collect();
    if capped.is_empty() {
        "doc".into()
    } else {
        capped
    }
}

// --- local ingestion -------------------------------------------------------

/// Validate one local file and produce embedder-ready metadata.
///
/// Returns `None` on any validation failure; never errors. The magic-byte
/// check is the point: a `.pdf` that is not a PDF wastes an extraction
/// attempt and can land garbage in the corpus.
pub fn ingest_local_file(
    path: &Path,
    source_url: Option<&str>,
    doc_type_override: Option<&str>,
    title_override: Option<&str>,
    effective_date_override: Option<&str>,
) -> Option<PdfMeta> {
    if !path.is_file() {
        tracing::warn!("ingest skipped, not a file: {}", path.display());
        return None;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !SUPPORTED_EXTS.contains(&ext.as_str()) {
        tracing::warn!("ingest skipped, unsupported extension '{ext}': {}", path.display());
        return None;
    }

    // Magic-byte sanity check on the container formats.
    if ext == "pdf" || ext == "docx" {
        let Ok(head) = read_head(path, 5) else {
            tracing::warn!("ingest skipped, unreadable: {}", path.display());
            return None;
        };
        let ok = if ext == "pdf" {
            head.starts_with(b"%PDF-")
        } else {
            head.starts_with(b"PK")
        };
        if !ok {
            tracing::warn!("ingest skipped, {} is not a valid {ext}", path.display());
            return None;
        }
    }

    let fetched_at = Utc::now().format("%Y-%m-%dT%H:%M:%S+00:00").to_string();
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let title: String = title_override
        .unwrap_or(stem)
        .chars()
        .take(240)
        .collect();
    let url = source_url
        .map(str::to_string)
        .unwrap_or_else(|| path_to_file_uri(path));
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    Some(PdfMeta {
        local_path: path.display().to_string(),
        source_url: url,
        document_type: doc_type_override
            .map(str::to_string)
            .unwrap_or_else(|| classify_doc_type(path)),
        document_title: title,
        fetched_at,
        effective_date: effective_date_override
            .map(str::to_string)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| parse_effective_date(file_name)),
        is_superseded: false,
        superseded_by: String::new(),
    })
}

fn read_head(path: &Path, n: usize) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut buf = vec![0u8; n];
    let read = f.read(&mut buf)?;
    buf.truncate(read);
    Ok(buf)
}

fn path_to_file_uri(path: &Path) -> String {
    let s = path.display().to_string().replace('\\', "/");
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

#[derive(Debug, Default)]
pub struct IngestReport {
    pub ingested: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
    pub metadata: Vec<PdfMeta>,
}

/// Recursively scan `folder` for new PDF / DOCX / TXT and ingest them.
///
/// Recursive because IK-fetched `.txt` files land under
/// `<docs>/<doc_type>/`, and the same scan must cover them.
pub fn ingest_local_documents(folder: &Path) -> IngestReport {
    std::fs::create_dir_all(folder).ok();
    let mut known = load_known_urls();
    let mut report = IngestReport::default();

    let mut files: Vec<PathBuf> = Vec::new();
    walk(folder, 0, &mut files);
    files.sort();

    tracing::info!(
        "manual ingest: scanning {} ({} files, {} known keys)",
        folder.display(),
        files.len(),
        known.len()
    );

    for entry in files {
        let ext = entry
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !SUPPORTED_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let key = file_key(&entry);
        if known.contains(&key) {
            report.skipped += 1;
            continue;
        }
        match ingest_local_file(&entry, None, None, None, None) {
            Some(meta) => {
                report.metadata.push(meta);
                known.insert(key);
            }
            None => report.errors.push(format!(
                "validation failed: {}",
                entry.file_name().and_then(|n| n.to_str()).unwrap_or("?")
            )),
        }
    }
    report.ingested = report.metadata.len();
    if let Err(e) = save_known_urls(&known, None) {
        tracing::warn!("could not persist the dedup set: {e}");
    }
    tracing::info!(
        "manual ingest: ingested={} skipped={} errors={}",
        report.ingested,
        report.skipped,
        report.errors.len()
    );
    report
}

/// Bounded recursive walk. The depth cap stops a symlink cycle in the user's
/// drop folder from hanging a sync.
fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => walk(&path, depth + 1, out),
            Ok(ft) if ft.is_file() => out.push(path),
            _ => {}
        }
    }
}

// --- Indian Kanoon --------------------------------------------------------

#[derive(Debug, Default)]
pub struct ScrapeReport {
    pub downloaded: Vec<PdfMeta>,
    pub errors: Vec<String>,
    pub sources_ok: Vec<String>,
    pub sources_bad: Vec<String>,
}

#[derive(Deserialize)]
struct IkSearchResponse {
    #[serde(default)]
    docs: Vec<IkRow>,
}

#[derive(Deserialize, Clone)]
struct IkRow {
    #[serde(default)]
    tid: Option<serde_json::Value>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    docsource: Option<String>,
}

/// One pooled client per sync run.
///
/// A full sync issues up to ~250 requests to one host. A fresh client per
/// request meant 250 TLS handshakes, roughly 100-200ms of pure setup each.
fn ik_client(token: &str) -> Result<reqwest::Client> {
    use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Token {token}"))?,
    );
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(USER_AGENT, HeaderValue::from_static(UA));
    Ok(reqwest::Client::builder()
        .timeout(IK_TIMEOUT)
        .default_headers(headers)
        .build()?)
}

/// POST to an IK endpoint. `None` on any failure — never errors into the
/// scheduler. Handles 403 (bad token) and 429 (one short retry).
async fn ik_post(
    client: &reqwest::Client,
    url: &str,
    form: &[(&str, String)],
) -> Option<serde_json::Value> {
    for attempt in 1..=2 {
        let resp = match client.post(url).form(form).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("[ik] POST {url} failed: {e}");
                return None;
            }
        };
        let status = resp.status().as_u16();
        match status {
            200 => {
                return match resp.json::<serde_json::Value>().await {
                    Ok(v) => Some(v),
                    Err(e) => {
                        tracing::warn!("[ik] {url} returned non-JSON: {e}");
                        None
                    }
                }
            }
            403 => {
                tracing::error!("[ik] 403 - the Indian Kanoon token was rejected at {url}");
                return None;
            }
            429 if attempt == 1 => {
                tracing::warn!("[ik] 429 rate-limited; one retry after 5s");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
            other => {
                tracing::warn!("[ik] {url} -> HTTP {other}");
                return None;
            }
        }
    }
    None
}

/// Keep only central-government law.
///
/// `doctypes:laws` keeps judgments out but still surfaces state statutes
/// (Kerala Building Tax Act, J&K Constitution) and the Constitution itself.
/// `docsource` separates them with a "Union of India" prefix.
fn is_relevant_ik_row(row: &IkRow) -> bool {
    match row.docsource.as_deref() {
        Some(src) if !src.is_empty() => src.starts_with("Union of India"),
        _ => true,
    }
}

/// Run one search page and return the rows worth keeping.
///
/// `doctypes` is appended **inline** to `formInput` as
/// `"<query> doctypes:<bucket>"`. The separate POST body field of the same
/// name is ignored by the live API; only the inline selector is honoured.
async fn ik_search(
    client: &reqwest::Client,
    query: &str,
    page: u32,
    doctypes: Option<&str>,
) -> Vec<IkRow> {
    let form_input = match doctypes {
        Some(d) => format!("{query} doctypes:{d}"),
        None => query.to_string(),
    };
    let form = [
        ("formInput", form_input),
        ("pagenum", page.to_string()),
    ];
    let Some(payload) = ik_post(client, IK_SEARCH_URL, &form).await else {
        return Vec::new();
    };
    let parsed: IkSearchResponse = match serde_json::from_value(payload) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let total = parsed.docs.len();
    let mut kept = Vec::new();
    let mut dropped = 0;
    for row in parsed.docs {
        if !is_relevant_ik_row(&row) {
            dropped += 1;
            continue;
        }
        let title = strip_html_tags(row.title.as_deref().unwrap_or(""));
        let title_l = collapse_ws(&title.to_lowercase());
        if !IK_TITLE_KEYWORDS.iter().any(|kw| title_l.contains(kw)) {
            dropped += 1;
            continue;
        }
        kept.push(row);
    }
    tracing::info!(
        "[ik] q={query:?} page={page} kept={} dropped={dropped} total={total}",
        kept.len()
    );
    kept
}

/// Search queries for this sync. Year-anchored ones roll forward in January
/// with no source edit.
fn build_ik_queries() -> Vec<(&'static str, String)> {
    let year = Utc::now().year();
    vec![
        ("laws", "Income Tax Act 2025".into()),
        ("laws", "Income Tax Rules 2026".into()),
        ("laws", format!("Finance Act {year}")),
        ("laws", format!("Finance Act {}", year - 1)),
        ("laws", "Income Tax Act".into()),
        // Topic sweeps: section-level results the broad query may not reach
        // within its first 5 pages.
        ("laws", "Income Tax Act 1961 assessment".into()),
        ("laws", "Income Tax Act 2025 capital gains".into()),
        ("laws", "Income Tax Act 2025 deductions".into()),
        ("laws", "Income Tax Act 2025 TDS".into()),
        ("laws", "Income Tax Act 1961 penalties".into()),
    ]
}

/// Pull an ISO date out of an IK docmeta block.
fn parse_ik_date(meta: &serde_json::Value) -> String {
    for key in ["publishdate", "docdate", "date"] {
        let Some(v) = meta.get(key) else { continue };
        let s = match v {
            serde_json::Value::String(s) => s.trim().to_string(),
            other => other.to_string().trim_matches('"').to_string(),
        };
        if s.is_empty() {
            continue;
        }
        if s.len() >= 10 && NaiveDate::parse_from_str(&s[..10], "%Y-%m-%d").is_ok() {
            return s[..10].to_string();
        }
        let d = parse_effective_date(&s);
        if !d.is_empty() {
            return d;
        }
    }
    String::new()
}

/// Search IK, download each new document as `.txt`.
pub async fn scrape_indian_kanoon(cfg: &AppConfig) -> ScrapeReport {
    let token = cfg.indiankanoon_token.trim();
    if token.is_empty() {
        tracing::warn!(
            "indiankanoon_token is empty; skipping the API scrape. \
             The manual drop folder is still active."
        );
        return ScrapeReport {
            errors: vec!["indiankanoon_token missing".into()],
            sources_bad: vec![IK_API_BASE.into()],
            ..Default::default()
        };
    }
    let client = match ik_client(token) {
        Ok(c) => c,
        Err(e) => {
            return ScrapeReport {
                errors: vec![format!("could not build an HTTP client: {e}")],
                sources_bad: vec![IK_API_BASE.into()],
                ..Default::default()
            }
        }
    };

    // Phase 1: collect unique doc ids across every query.
    let queries = build_ik_queries();
    tracing::info!(
        "[ik] starting scrape - {} queries x {} pages",
        queries.len(),
        IK_SEARCH_PAGES.len()
    );
    let mut seen: HashMap<String, IkRow> = HashMap::new();
    for (doctypes, query) in &queries {
        for page in IK_SEARCH_PAGES {
            let rows = ik_search(&client, query, page, Some(doctypes)).await;
            tokio::time::sleep(API_DELAY).await;
            for row in rows {
                let Some(tid) = row.tid.as_ref() else { continue };
                let docid = match tid {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Number(n) => n.to_string(),
                    _ => continue,
                };
                // `docid` is interpolated into three URL paths below, and it
                // arrives from a remote response. Real Indian Kanoon tids are
                // decimal integers; anything else -- a `..` segment, an `@`
                // that re-points the authority, a stray `/` -- would reshape
                // the URL rather than fill in a path component. Dropped
                // rather than escaped: a non-numeric tid is not a document
                // this code knows how to fetch anyway.
                if docid.is_empty() || !docid.chars().all(|c| c.is_ascii_digit()) {
                    tracing::warn!("[ik] skipping a result with a non-numeric tid");
                    continue;
                }
                seen.entry(docid).or_insert(row);
            }
        }
    }
    if seen.is_empty() {
        tracing::warn!("[ik] no results across any query; the API or token may be unhealthy");
        return ScrapeReport {
            errors: vec!["no search results from Indian Kanoon".into()],
            sources_bad: vec![IK_API_BASE.into()],
            ..Default::default()
        };
    }
    tracing::info!("[ik] collected {} unique docids", seen.len());

    // Phase 2: dedup against known_urls, then download.
    let mut known = load_known_urls();
    let mut report = ScrapeReport::default();
    let mut budget = MAX_NEW_DOWNLOADS_PER_SYNC;

    for (docid, row) in seen {
        if budget == 0 {
            tracing::info!("[ik] download budget exhausted");
            break;
        }
        let public_url = format!("{IK_PUBLIC_URL_PREFIX}{docid}/");
        let key = url_hash(&public_url);
        if known.contains(&key) {
            continue;
        }

        let meta_url = format!("{IK_API_BASE}/docmeta/{docid}/");
        let Some(meta_json) = ik_post(&client, &meta_url, &[]).await else {
            report.errors.push(format!("docmeta fetch failed: {docid}"));
            tokio::time::sleep(API_DELAY).await;
            continue;
        };
        tokio::time::sleep(API_DELAY).await;

        let raw_title = meta_json
            .get("title")
            .and_then(|v| v.as_str())
            .or(row.title.as_deref())
            .unwrap_or("");
        let title = {
            let t = strip_html_tags(raw_title);
            if t.is_empty() { format!("doc-{docid}") } else { t }
        };
        let doc_type = classify_ik_title(&title);
        let effective_date = {
            let d = parse_ik_date(&meta_json);
            if d.is_empty() { parse_effective_date(&title) } else { d }
        };

        // Freshness gate runs BEFORE the body fetch: it saves a round trip
        // plus the throttle for every rejected document.
        if is_too_old(&doc_type, &effective_date) {
            tracing::info!("[ik] skipped {docid}, too old ({effective_date}): {title:.80}");
            continue;
        }

        let doc_url = format!("{IK_API_BASE}/doc/{docid}/");
        let Some(doc_json) = ik_post(&client, &doc_url, &[]).await else {
            report.errors.push(format!("doc fetch failed: {docid}"));
            tokio::time::sleep(API_DELAY).await;
            continue;
        };
        tokio::time::sleep(API_DELAY).await;

        let html = doc_json.get("doc").and_then(|v| v.as_str()).unwrap_or("");
        let text = strip_html_to_text(html);
        if text.trim().is_empty() {
            report.errors.push(format!("empty body: {docid}"));
            continue;
        }

        let save_dir = paths::rag_docs_dir().join(&doc_type);
        if let Err(e) = std::fs::create_dir_all(&save_dir) {
            report.errors.push(format!("mkdir failed: {docid}: {e}"));
            continue;
        }
        let fname = format!("{docid}_{}.txt", sanitise_filename_part(&title, 80));
        let save_path = save_dir.join(&fname);
        if let Err(e) = std::fs::write(&save_path, text.as_bytes()) {
            tracing::warn!("[ik] could not write {}: {e}", save_path.display());
            report.errors.push(format!("write failed: {docid}: {e}"));
            continue;
        }

        match ingest_local_file(
            &save_path,
            Some(&public_url),
            Some(&doc_type),
            Some(&title),
            Some(&effective_date),
        ) {
            Some(meta) => {
                report.downloaded.push(meta);
                // Both keys, so a later rescan skips the file and the API is
                // never asked for this document again.
                known.insert(key);
                known.insert(file_key(&save_path));
                budget -= 1;
                tracing::info!("[ik] saved {docid} type={doc_type} as {fname}");
            }
            None => report
                .errors
                .push(format!("validation failed after save: {fname}")),
        }
    }

    if let Err(e) = save_known_urls(&known, None) {
        tracing::warn!("[ik] could not persist the dedup set: {e}");
    }
    tracing::info!(
        "[ik] done - fetched={} errors={}",
        report.downloaded.len(),
        report.errors.len()
    );
    if !report.downloaded.is_empty() || report.errors.is_empty() {
        report.sources_ok.push(IK_API_BASE.into());
    } else {
        report.sources_bad.push(IK_API_BASE.into());
    }
    report
}

// --- orchestrator ----------------------------------------------------------

/// One full sync pass.
///
/// Phases: manual ingest, Indian Kanoon, then a rescan to pick up anything
/// that bypassed direct ingest. Every phase is independently fault-isolated —
/// a failure in one must not abort the others, because a sync is unattended.
///
/// The `incometaxindia.gov.in` direct-PDF probe stays behind
/// `incometax_pdf_scraper_enabled`, off by default.
pub async fn scrape_all_sources(cfg: &AppConfig) -> ScrapeReport {
    let mut report = ScrapeReport::default();
    let docs_dir = paths::rag_docs_dir();

    tracing::info!("sync phase A - manual ingest from {}", docs_dir.display());
    let manual = ingest_local_documents(&docs_dir);
    report.downloaded.extend(manual.metadata);
    report.errors.extend(manual.errors);
    report.sources_ok.push(docs_dir.display().to_string());

    tracing::info!("sync phase B - Indian Kanoon API");
    let ik = scrape_indian_kanoon(cfg).await;
    report.downloaded.extend(ik.downloaded);
    report.errors.extend(ik.errors);
    report.sources_ok.extend(ik.sources_ok);
    report.sources_bad.extend(ik.sources_bad);

    if cfg.incometax_pdf_scraper_enabled {
        tracing::info!("sync phase C - incometaxindia.gov.in /news/ probe (enabled by config)");
        // Not ported: v1's probe walks ~400 serial-numbered URLs against a
        // host that 403s most of them at Akamai's edge, for a yield that was
        // near zero in practice. Enabling the flag therefore records a clear
        // message rather than silently doing nothing.
        report.errors.push(
            "the incometaxindia.gov.in PDF probe is not implemented in this backend; \
             drop the PDFs into the documents folder instead"
                .into(),
        );
    }

    tracing::info!("sync phase D - rescan the drop folder");
    let rescan = ingest_local_documents(&docs_dir);
    if !rescan.metadata.is_empty() {
        tracing::info!(
            "[rescan] picked up {} file(s) missed by direct ingest",
            rescan.metadata.len()
        );
    }
    report.downloaded.extend(rescan.metadata);
    report.errors.extend(rescan.errors);

    tracing::info!(
        "sync done - downloaded={} ok={} bad={} errors={}",
        report.downloaded.len(),
        report.sources_ok.len(),
        report.sources_bad.len(),
        report.errors.len()
    );
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ik_titles_bucket_by_specificity() {
        // Whitespace runs are what break a naive substring match.
        assert_eq!(
            classify_ik_title("Section 80C in The  Income   Tax   Act, 1961"),
            "income_tax_act"
        );
        assert_eq!(classify_ik_title("The Income Tax Rules, 1962"), "income_tax_rules");
        assert_eq!(classify_ik_title("Finance Act 2026"), "finance_act");
        assert_eq!(classify_ik_title("Circular regarding TDS"), "circular");
        assert_eq!(classify_ik_title("Something else"), "cbdt_general");
    }

    #[test]
    fn filenames_classify_by_stem() {
        assert_eq!(classify_doc_type(Path::new("circular-no-5-2024.pdf")), "circular");
        assert_eq!(classify_doc_type(Path::new("income-tax-act-1961.txt")), "income_tax_act");
        assert_eq!(classify_doc_type(Path::new("random.pdf")), "unknown");
    }

    #[test]
    fn statutes_are_never_age_expired() {
        // IK stamps the IT Act with 1961; it is still current law.
        assert!(!is_too_old("income_tax_act", "1961-01-01"));
        assert!(!is_too_old("income_tax_rules", "1962-01-01"));
        assert!(!is_too_old("finance_act", "1990-01-01"));
    }

    #[test]
    fn stale_circulars_are_expired_but_undated_ones_survive() {
        assert!(is_too_old("circular", "2010-01-01"));
        assert!(!is_too_old("circular", ""), "an undated doc must not be dropped");
        assert!(!is_too_old("circular", "not-a-date"));
        let today = Utc::now().format("%Y-%m-%d").to_string();
        assert!(!is_too_old("circular", &today));
    }

    #[test]
    fn bold_tags_are_scrubbed_from_titles() {
        // Without this, filenames and metadata carry raw markup.
        assert_eq!(
            strip_html_tags("The <b>Income</b> <b>Tax</b> Act, 1961"),
            "The Income Tax Act, 1961"
        );
        assert_eq!(strip_html_tags(""), "");
    }

    #[test]
    fn entities_are_decoded_without_double_decoding() {
        assert_eq!(strip_html_tags("M&amp;s Sharma"), "M&s Sharma");
        // &amp;lt; must become &lt;, not <.
        assert_eq!(strip_html_tags("&amp;lt;"), "&lt;");
    }

    #[test]
    fn script_content_never_reaches_the_corpus() {
        let html = "<html><body><p>Real text</p><script>var evil=1;</script></body></html>";
        let text = strip_html_to_text(html);
        assert!(text.contains("Real text"));
        assert!(!text.contains("evil"), "script bodies must be dropped: {text:?}");
    }

    #[test]
    fn html_to_text_keeps_paragraph_structure() {
        let html = "<p>Para one</p><p>Para two</p>";
        let text = strip_html_to_text(html);
        assert!(text.contains("Para one"));
        assert!(text.contains("Para two"));
    }

    #[test]
    fn filename_parts_cannot_escape_the_directory() {
        assert!(!sanitise_filename_part("../../etc/passwd", 80).contains('/'));
        assert!(!sanitise_filename_part(r"..\..\config", 80).contains('\\'));
        assert_eq!(sanitise_filename_part("", 80), "doc");
        assert_eq!(sanitise_filename_part("...", 80), "doc");
        assert!(sanitise_filename_part(&"a".repeat(500), 80).len() <= 80);
    }

    #[test]
    fn state_statutes_are_filtered_out() {
        let row = IkRow {
            tid: Some(serde_json::json!(1)),
            title: Some("Kerala Building Tax Act".into()),
            docsource: Some("Kerala".into()),
        };
        assert!(!is_relevant_ik_row(&row));
        let row = IkRow {
            tid: Some(serde_json::json!(2)),
            title: Some("Income Tax Act".into()),
            docsource: Some("Union of India - Section".into()),
        };
        assert!(is_relevant_ik_row(&row));
    }

    #[test]
    fn ik_dates_parse_from_any_of_the_three_keys() {
        assert_eq!(
            parse_ik_date(&serde_json::json!({"publishdate": "2024-03-15"})),
            "2024-03-15"
        );
        assert_eq!(
            parse_ik_date(&serde_json::json!({"docdate": "15 March 2024"})),
            "2024-01-01"
        );
        assert_eq!(parse_ik_date(&serde_json::json!({})), "");
    }

    #[test]
    fn queries_roll_forward_with_the_calendar() {
        let year = Utc::now().year();
        let queries = build_ik_queries();
        assert!(queries.iter().any(|(_, q)| q == &format!("Finance Act {year}")));
        assert!(queries.iter().any(|(_, q)| q == &format!("Finance Act {}", year - 1)));
    }

    #[test]
    fn a_renamed_binary_is_not_ingested() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("notice.pdf");
        std::fs::write(&fake, b"MZ\x90\x00 this is an exe").unwrap();
        assert!(ingest_local_file(&fake, None, None, None, None).is_none());
    }

    #[test]
    fn a_real_pdf_header_is_accepted_and_classified() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("circular-no-5-2024.pdf");
        std::fs::write(&path, b"%PDF-1.7\nbody").unwrap();
        let meta = ingest_local_file(&path, None, None, None, None).unwrap();
        assert_eq!(meta.document_type, "circular");
        assert_eq!(meta.effective_date, "2024-01-01");
        assert!(!meta.is_superseded);
        assert!(meta.source_url.starts_with("file:"));
    }

    #[test]
    fn overrides_win_over_inference() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("12345_The_Income_Tax_Act.txt");
        std::fs::write(&path, b"text").unwrap();
        let meta = ingest_local_file(
            &path,
            Some("https://indiankanoon.org/doc/12345/"),
            Some("income_tax_act"),
            Some("The Income Tax Act, 1961"),
            Some("1961-01-01"),
        )
        .unwrap();
        assert_eq!(meta.source_url, "https://indiankanoon.org/doc/12345/");
        assert_eq!(meta.document_type, "income_tax_act");
        assert_eq!(meta.effective_date, "1961-01-01");
    }

    #[test]
    fn unsupported_extensions_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.xlsx");
        std::fs::write(&path, b"PK\x03\x04").unwrap();
        assert!(ingest_local_file(&path, None, None, None, None).is_none());
    }

    #[test]
    fn file_keys_change_when_the_file_does() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        std::fs::write(&path, b"one").unwrap();
        let first = file_key(&path);
        std::fs::write(&path, b"a much longer body than before").unwrap();
        assert_ne!(first, file_key(&path), "a replaced file must re-ingest");
    }

    #[test]
    fn supersession_pairs_are_ordered_old_then_new() {
        for (old, new) in SUPERSESSION_PAIRS {
            assert_ne!(old, new);
            // The 1961/1962 originals are the ones that get superseded.
            assert!(old.contains("1961") || old.contains("1962"));
        }
    }
}
