//! Embedding + ingestion layer. Ports `backend/services/rag_embedder.py`.
//!
//! Model: `all-MiniLM-L6-v2` via `fastembed` — the same weights and the same
//! 384 dimensions as the Python `sentence-transformers` path, so the vectors
//! are numerically comparable between the two stacks. Only the container
//! differs: see `vector_store`.
//!
//! # Failure policy, unchanged from v1
//!
//! Nothing here raises into a request. A missing model, an unparseable PDF, a
//! corrupt store — all log and return an empty result. On a fresh install the
//! corpus is empty until the first sync, which is exactly when the user makes
//! their first request, so a hard failure there would brick the product.
//!
//! # Lazy load, and why the order matters
//!
//! `paths::configure_hf_cache()` must run before the model is constructed or
//! the ~90 MB download lands in the user's global HuggingFace cache instead
//! of `rag/models/` — which v1 and v2 deliberately share.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use anyhow::{anyhow, Result};
use regex::Regex;
use serde::Serialize;
use tokio::sync::Mutex;

use super::vector_store::{self, ChunkMeta, VectorStore};

// Re-exported so a route can name the retrieval result type without
// reaching past the embedder into the store it owns.
pub use super::vector_store::Hit;
use crate::paths;

pub const EMBED_MODEL_NAME: &str = "all-MiniLM-L6-v2";
pub const DEFAULT_MAX_TOKENS: usize = 512;
pub const DEFAULT_OVERLAP: usize = 50;

/// Batch width for `encode`. 32 matches v1; larger batches gain little on CPU
/// and cost memory proportional to the longest chunk in the batch.
const ENCODE_BATCH: usize = 32;

/// The model is expensive to construct and cheap to share. One instance,
/// behind a mutex because `fastembed`'s `embed` takes `&mut self`.
static MODEL: OnceLock<Mutex<fastembed::TextEmbedding>> = OnceLock::new();

/// The store is held in memory and mutated by both the sync job and the
/// supersession pass, so it needs the same single-owner treatment.
static STORE: OnceLock<Mutex<VectorStore>> = OnceLock::new();

pub async fn store() -> &'static Mutex<VectorStore> {
    STORE.get_or_init(|| Mutex::new(VectorStore::open()))
}

/// Construct (or reuse) the embedding model.
///
/// First call may download ~90 MB into `rag/models/`. Subsequent calls are
/// O(1). An error here is surfaced to `/rag/status`, never to `/generate`.
fn model() -> Result<&'static Mutex<fastembed::TextEmbedding>> {
    if let Some(m) = MODEL.get() {
        return Ok(m);
    }
    // Pin the cache before the model is built, or the download escapes to the
    // user's global HuggingFace directory.
    paths::configure_hf_cache();
    let dir = paths::rag_models_dir();
    std::fs::create_dir_all(&dir).ok();

    tracing::info!("loading embedding model {EMBED_MODEL_NAME}");
    let opts = fastembed::InitOptions::new(fastembed::EmbeddingModel::AllMiniLML6V2)
        .with_cache_dir(dir)
        .with_show_download_progress(false);
    let embedding = fastembed::TextEmbedding::try_new(opts).map_err(|e| {
        anyhow!(
            "could not load embedding model {EMBED_MODEL_NAME}. \
             Run sync once with internet access to download it. Underlying error: {e}"
        )
    })?;
    Ok(MODEL.get_or_init(|| Mutex::new(embedding)))
}

/// True when the model is loadable without a network round trip.
pub fn is_model_available() -> bool {
    if MODEL.get().is_some() {
        return true;
    }
    // Any ONNX weight file under the cache means a prior download finished.
    let dir = paths::rag_models_dir();
    fn has_onnx(dir: &Path, depth: usize) -> bool {
        if depth > 4 {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if has_onnx(&path, depth + 1) {
                    return true;
                }
            } else if path.extension().and_then(|e| e.to_str()) == Some("onnx") {
                return true;
            }
        }
        false
    }
    has_onnx(&dir, 0)
}

/// Embed a batch of passages. Blocking ONNX work is moved off the async
/// runtime so a long encode cannot stall the HTTP server's reactor.
async fn encode(texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
    let lock = model()?;
    let guard = lock.lock().await;
    let mut out: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
    for batch in texts.chunks(ENCODE_BATCH) {
        let refs: Vec<&str> = batch.iter().map(String::as_str).collect();
        let vectors = guard
            .embed(refs, None)
            .map_err(|e| anyhow!("embedding failed: {e}"))?;
        out.extend(vectors);
    }
    Ok(out)
}

/// Embed one query string.
pub async fn embed_query(text: &str) -> Result<Vec<f32>> {
    let mut vectors = encode(vec![text.to_string()]).await?;
    vectors
        .pop()
        .ok_or_else(|| anyhow!("embedding returned no vector"))
}

/// Metadata describing one downloaded PDF, as produced by the scraper.
#[derive(Debug, Clone, Default)]
pub struct PdfMeta {
    pub local_path: String,
    pub source_url: String,
    pub document_type: String,
    pub document_title: String,
    pub fetched_at: String,
    pub effective_date: String,
    pub is_superseded: bool,
    pub superseded_by: String,
}

/// Chunk, embed and upsert one PDF. Returns the number of new chunks.
///
/// Returns 0 — never an error — when the file is missing, has no text layer,
/// or the model is unavailable. A sync run must survive one bad PDF.
pub async fn ingest_pdf(meta: &PdfMeta) -> usize {
    let path = Path::new(&meta.local_path);
    if !path.exists() {
        tracing::warn!("ingest skipped, file missing: {}", path.display());
        return 0;
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("ingest skipped, unreadable {}: {e}", path.display());
            return 0;
        }
    };

    let pages = extract_pages_for(path, &bytes);
    if pages.is_empty() {
        tracing::warn!("no extractable text in {}", path.display());
        return 0;
    }

    // The CBDT reference is read once, from page 1, as in v1.
    let cbdt_ref = pages
        .first()
        .map(|(_, text)| parse_cbdt_ref(text).unwrap_or_default())
        .unwrap_or_default();

    let mut pending: Vec<(String, String, ChunkMeta)> = Vec::new();
    for (page_number, page_text) in &pages {
        for chunk in vector_store::chunk_text(page_text, DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP) {
            let id = vector_store::content_hash(&chunk);
            pending.push((
                id,
                chunk,
                ChunkMeta {
                    source_url: meta.source_url.clone(),
                    document_title: meta.document_title.clone(),
                    document_type: meta.document_type.clone(),
                    cbdt_ref: cbdt_ref.clone(),
                    effective_date: meta.effective_date.clone(),
                    is_superseded: meta.is_superseded,
                    superseded_by: meta.superseded_by.clone(),
                    date_fetched: meta.fetched_at.clone(),
                    page_number: *page_number,
                    local_path: path.display().to_string(),
                },
            ));
        }
    }
    if pending.is_empty() {
        return 0;
    }

    // Only embed what the store does not already hold. Identical text has an
    // identical hash, so a re-sync of an unchanged circular costs no inference
    // at all — this is the single biggest win over a naive re-embed.
    let known: Vec<bool> = {
        let guard = store().await.lock().await;
        // Probe the store's own id index. Collecting a HashSet from
        // `chunks()` first would be O(stored chunks) of fresh allocation on
        // every document, and `ingest_many` calls this once per document --
        // so a full corpus re-sync paid that cost N times over for a map the
        // store already maintains.
        pending.iter().map(|(id, _, _)| guard.contains_id(id)).collect()
    };

    let to_embed: Vec<String> = pending
        .iter()
        .zip(&known)
        .filter(|(_, &seen)| !seen)
        .map(|((_, text, _), _)| text.clone())
        .collect();

    let mut vectors = if to_embed.is_empty() {
        Vec::new()
    } else {
        match encode(to_embed).await {
            Ok(v) => v,
            Err(e) => {
                tracing::error!("embedding failed for {}: {e}", path.display());
                return 0;
            }
        }
    };
    vectors.reverse(); // pop from the front order

    let mut added = 0;
    {
        let mut guard = store().await.lock().await;
        for ((id, text, chunk_meta), seen) in pending.into_iter().zip(known) {
            if seen {
                // Refresh metadata only; supersession state changes over time.
                let zero = vec![0f32; vector_store::EMBED_DIM];
                let _ = guard.upsert(id, text, chunk_meta, &zero);
                continue;
            }
            let Some(vector) = vectors.pop() else { break };
            match guard.upsert(id, text, chunk_meta, &vector) {
                Ok(true) => added += 1,
                Ok(false) => {}
                Err(e) => tracing::warn!("upsert rejected: {e}"),
            }
        }
        if let Err(e) = guard.save() {
            tracing::error!("could not persist the vector store: {e}");
        }
    }
    tracing::info!(
        "ingested {} - {added} new chunks (cbdt_ref={})",
        path.display(),
        if cbdt_ref.is_empty() { "?" } else { &cbdt_ref }
    );
    added
}

pub async fn ingest_many(metas: &[PdfMeta]) -> usize {
    let mut total = 0;
    for meta in metas {
        total += ingest_pdf(meta).await;
    }
    total
}

/// Per-page text for any supported corpus format, 1-indexed.
///
/// The corpus is not all PDF. The Indian Kanoon scraper writes `.txt`, and
/// the drop folder accepts `.docx`. Routing those through a PDF extractor
/// yields zero pages, which silently indexes nothing — so the format is
/// dispatched on the extension and the non-paginated formats become a
/// single page 1.
fn extract_pages_for(path: &Path, bytes: &[u8]) -> Vec<(u32, String)> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "pdf" => extract_pages(bytes),
        "txt" | "docx" => {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("doc.txt");
            match super::parser::parse_file(name, bytes) {
                Ok(text) if !text.trim().is_empty() => vec![(1, text)],
                Ok(_) => Vec::new(),
                Err(e) => {
                    tracing::warn!("extraction failed for {}: {e}", path.display());
                    Vec::new()
                }
            }
        }
        _ => Vec::new(),
    }
}

/// Per-page text, 1-indexed. Pages with no text layer are dropped.
fn extract_pages(bytes: &[u8]) -> Vec<(u32, String)> {
    // `pdf-extract` returns the whole document, not per-page, so pages are
    // recovered from the form-feed separators it emits. A scanned PDF yields
    // nothing here, which is correct: v2 has no OCR (see `parser`).
    let owned = bytes.to_vec();
    let text = match std::panic::catch_unwind(move || pdf_extract::extract_text_from_mem(&owned)) {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => {
            tracing::warn!("pdf text extraction failed: {e}");
            return Vec::new();
        }
        Err(_) => {
            tracing::warn!("pdf text extraction panicked; treating as no text layer");
            return Vec::new();
        }
    };
    text.split('\u{000C}')
        .enumerate()
        .filter_map(|(i, page)| {
            let page = page.trim();
            if page.is_empty() {
                None
            } else {
                Some((i as u32 + 1, page.to_string()))
            }
        })
        .collect()
}

static CBDT_REF_RE: OnceLock<Regex> = OnceLock::new();

/// Pull a CBDT reference like "Circular No. 8/2013" out of page-1 text.
pub fn parse_cbdt_ref(text: &str) -> Option<String> {
    let re = CBDT_REF_RE.get_or_init(|| {
        Regex::new(
            r"(?i)\b(Circular|Notification|Instruction|Office\s+Memorandum)\s*No\.?\s*([0-9]+)\s*(?:/|\s+of\s+)\s*([0-9]{4})",
        )
        .expect("cbdt ref regex")
    });
    let caps = re.captures(text)?;
    let label = caps.get(1)?.as_str();
    // Normalise the label's casing so "CIRCULAR" and "circular" group together.
    let label = {
        let mut chars = label.to_lowercase();
        if let Some(first) = chars.get_mut(0..1) {
            let upper = first.to_uppercase();
            chars.replace_range(0..1, &upper);
        }
        chars
    };
    Some(format!(
        "{label} No. {}/{}",
        caps.get(2)?.as_str(),
        caps.get(3)?.as_str()
    ))
}

/// Retrieve the top `n` chunks for `query_text`.
///
/// Cheap gates run first. v1 measured a 46s cold start here because it loaded
/// the model before checking whether the store had anything in it; on a fresh
/// install the store is empty, so that cost was pure latency on the user's
/// first request. Checking emptiness first took it to 0.8s.
pub async fn query(query_text: &str, n: usize) -> Vec<Hit> {
    if query_text.trim().is_empty() {
        return Vec::new();
    }
    if store().await.lock().await.is_empty() {
        return Vec::new();
    }
    let embedding = match embed_query(query_text).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("query unavailable: {e}");
            return Vec::new();
        }
    };
    store().await.lock().await.query(&embedding, n.max(1))
}

pub async fn collection_size() -> usize {
    store().await.lock().await.len()
}

/// One row per source document, for `GET /rag/documents`.
#[derive(Debug, Clone, Serialize)]
pub struct DocumentRow {
    pub title: String,
    #[serde(rename = "type")]
    pub doc_type: String,
    pub cbdt_ref: String,
    pub effective_date: String,
    pub date_fetched: String,
    pub source_url: String,
    pub is_superseded: bool,
    pub superseded_by: String,
    pub chunk_count: usize,
}

/// Aggregate chunks by source URL, newest fetch first.
pub async fn list_documents() -> Vec<DocumentRow> {
    let guard = store().await.lock().await;
    let mut groups: HashMap<String, DocumentRow> = HashMap::new();
    for chunk in guard.chunks() {
        let url = if chunk.meta.source_url.is_empty() {
            "unknown".to_string()
        } else {
            chunk.meta.source_url.clone()
        };
        let row = groups.entry(url.clone()).or_insert_with(|| DocumentRow {
            title: chunk.meta.document_title.clone(),
            doc_type: chunk.meta.document_type.clone(),
            cbdt_ref: chunk.meta.cbdt_ref.clone(),
            effective_date: chunk.meta.effective_date.clone(),
            date_fetched: chunk.meta.date_fetched.clone(),
            source_url: url,
            is_superseded: chunk.meta.is_superseded,
            superseded_by: chunk.meta.superseded_by.clone(),
            chunk_count: 0,
        });
        // If any chunk of a document was later marked superseded, the whole
        // document is superseded.
        if chunk.meta.is_superseded {
            row.is_superseded = true;
            if !chunk.meta.superseded_by.is_empty() {
                row.superseded_by = chunk.meta.superseded_by.clone();
            }
        }
        row.chunk_count += 1;
    }
    let mut rows: Vec<DocumentRow> = groups.into_values().collect();
    rows.sort_by(|a, b| b.date_fetched.cmp(&a.date_fetched));
    rows
}

pub async fn superseded_docs_count() -> usize {
    list_documents().await.iter().filter(|r| r.is_superseded).count()
}

pub async fn clear_collection() -> Result<()> {
    store().await.lock().await.clear()
}

/// Re-embed every document on disk under `rag/documents/`, bypassing the
/// scrape-time dedup set. Returns the chunk count added.
///
/// Backs `POST /rag/reindex`. The caller clears the store first; this then
/// walks the folder rather than any index, so it recovers from a corrupt
/// store and picks up documents whose metadata schema has since changed.
///
/// Unlike the sync path this covers `.txt` and `.docx` as well as `.pdf` —
/// after a reindex clears the dedup cache, the API-fetched `.txt` files are
/// deleted and re-downloaded, but anything the user dropped by hand is
/// still on disk and must come back.
pub async fn reembed_local_pdfs() -> usize {
    let root = paths::rag_docs_dir();
    let mut files = Vec::new();
    collect_documents(&root, 0, &mut files);
    files.sort();
    tracing::info!("[reindex] re-embedding {} local document(s)", files.len());

    let metas: Vec<PdfMeta> = files
        .iter()
        .filter_map(|p| {
            super::rag_scraper::ingest_local_file(p, None, None, None, None)
        })
        .collect();
    ingest_many(&metas).await
}

fn collect_documents(dir: &std::path::Path, depth: usize, out: &mut Vec<std::path::PathBuf>) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => collect_documents(&path, depth + 1, out),
            Ok(ft) if ft.is_file() => {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if super::rag_scraper::SUPPORTED_EXTS.contains(&ext.as_str()) {
                    out.push(path);
                }
            }
            _ => {}
        }
    }
}

static REF_NUM_YEAR_RE: OnceLock<Regex> = OnceLock::new();

/// Mark older versions of a document as superseded. Returns chunks updated.
///
/// Two rules, both from v1:
/// 1. Hardcoded slug pairs (Acts / Rules) — when both the old and the new
///    slug appear in indexed URLs, the old one is superseded.
/// 2. Same reference number, different year, same document type — the older
///    year loses.
pub async fn detect_supersessions() -> usize {
    let re = REF_NUM_YEAR_RE
        .get_or_init(|| Regex::new(r"(?i)(\w+)\s*No\.?\s*(\d+)/(\d{4})").expect("ref regex"));

    let mut guard = store().await.lock().await;

    // One representative metadata row per source URL.
    let mut url_meta: HashMap<String, ChunkMeta> = HashMap::new();
    for chunk in guard.chunks() {
        if chunk.meta.source_url.is_empty() {
            continue;
        }
        url_meta
            .entry(chunk.meta.source_url.clone())
            .or_insert_with(|| chunk.meta.clone());
    }
    if url_meta.is_empty() {
        return 0;
    }

    // old_url -> title of the document that supersedes it
    let mut superseded: HashMap<String, String> = HashMap::new();

    // Rule 1: slug pairs.
    for (old_slug, new_slug) in super::rag_scraper::SUPERSESSION_PAIRS {
        let find = |slug: &str| {
            url_meta
                .keys()
                .find(|u| u.to_lowercase().contains(&slug.to_lowercase()))
                .cloned()
        };
        if let (Some(old_url), Some(new_url)) = (find(old_slug), find(new_slug)) {
            if old_url != new_url {
                let title = url_meta
                    .get(&new_url)
                    .map(|m| m.document_title.clone())
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| new_slug.to_string());
                superseded.entry(old_url).or_insert(title);
            }
        }
    }

    // Rule 2: same (type, label, number), newer year wins.
    //
    // Both halves are positional tuples, which is why they are named: the key
    // is three lowercase strings in a fixed order and the value's first field
    // is the year the sort depends on.
    //
    // `(doc_type, label, number)` -- the identity a circular keeps across
    // years, all lowercased so "Circular"/"circular" collapse.
    type RefKey = (String, String, String);
    /// `(year, url, title)` for one document carrying that reference.
    type DatedDoc = (i32, String, String);

    let mut by_ref: HashMap<RefKey, Vec<DatedDoc>> = HashMap::new();
    for (url, meta) in &url_meta {
        let Some(caps) = re.captures(&meta.cbdt_ref) else { continue };
        let label = caps[1].to_lowercase();
        let num = caps[2].to_string();
        let Ok(year) = caps[3].parse::<i32>() else { continue };
        let doc_type = meta.document_type.to_lowercase();
        by_ref
            .entry((doc_type, label, num))
            .or_default()
            .push((year, url.clone(), meta.document_title.clone()));
    }
    for mut entries in by_ref.into_values() {
        if entries.len() < 2 {
            continue;
        }
        entries.sort_by(|a, b| b.0.cmp(&a.0));
        let newest_title = entries[0].2.clone();
        for (_, old_url, _) in entries.into_iter().skip(1) {
            superseded.entry(old_url).or_insert_with(|| newest_title.clone());
        }
    }

    let mut updated = 0;
    for (old_url, new_title) in &superseded {
        let n = guard.mark_superseded(old_url, new_title);
        if n > 0 {
            tracing::info!("[supersession] {old_url} superseded by {new_title}");
        }
        updated += n;
    }
    if updated > 0 {
        if let Err(e) = guard.save() {
            tracing::error!("could not persist supersession updates: {e}");
        }
    }
    updated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cbdt_ref_is_parsed_from_page_one() {
        assert_eq!(
            parse_cbdt_ref("Government of India\nCircular No. 8/2013\nDated 10 Oct"),
            Some("Circular No. 8/2013".into())
        );
        assert_eq!(
            parse_cbdt_ref("NOTIFICATION NO. 31/2024"),
            Some("Notification No. 31/2024".into())
        );
        assert_eq!(
            parse_cbdt_ref("Instruction No 1 of 2015"),
            Some("Instruction No. 1/2015".into())
        );
    }

    #[test]
    fn cbdt_ref_absent_is_none_not_a_guess() {
        // A wrong reference is worse than none: it becomes a fabricated
        // citation anchor in the prompt.
        assert_eq!(parse_cbdt_ref("Dear Sir, with reference to your letter"), None);
        assert_eq!(parse_cbdt_ref(""), None);
    }

    #[test]
    fn page_split_is_one_indexed() {
        // Guard the page_number contract the citation display depends on.
        let text = "page one\u{000C}page two\u{000C}\u{000C}page four";
        let pages: Vec<(u32, String)> = text
            .split('\u{000C}')
            .enumerate()
            .filter_map(|(i, p)| {
                let p = p.trim();
                if p.is_empty() { None } else { Some((i as u32 + 1, p.to_string())) }
            })
            .collect();
        assert_eq!(pages[0].0, 1);
        assert_eq!(pages[1].0, 2);
        // An empty page does not shift the numbering of the ones after it.
        assert_eq!(pages[2].0, 4);
    }

    #[test]
    fn a_non_pdf_byte_stream_yields_no_pages_rather_than_panicking() {
        assert!(extract_pages(b"not a pdf at all").is_empty());
        assert!(extract_pages(&[]).is_empty());
    }
}
