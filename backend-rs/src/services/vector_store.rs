//! v2's vector store. Replaces ChromaDB.
//!
//! # Why not reuse v1's store
//!
//! ChromaDB is a Python library over SQLite with its own internal HNSW
//! segment format. No Rust client reads it. Pointing v2 at
//! `rag/chromadb/` would mean reverse-engineering that format and risking
//! corruption of an installed user's only copy of their corpus. v2 therefore
//! owns `rag/vectors-rs/`, and switching stacks costs one re-embed. The
//! vectors themselves are comparable — both stacks use all-MiniLM-L6-v2 at
//! 384 dimensions — it is only the container that differs.
//!
//! # Design
//!
//! The corpus is a few thousand chunks, not millions. A flat store with
//! SIMD-friendly dot products over unit-normalised vectors beats an HNSW
//! index at this size: it is exact, has no build step, no graph to corrupt,
//! and a full scan of 10k x 384 f32 is well under a millisecond. The index
//! is a single `vectors.bin` (fixed-stride f32) plus a `meta.json` sidecar,
//! both written atomically.
//!
//! Cosine similarity reduces to a dot product because every vector is
//! normalised on insert. That is the whole reason the store is this simple.
//!
//! # Invariant
//!
//! The chunk id is the SHA-256 of the chunk text, exactly as in v1. Re-running
//! ingest over an unchanged PDF is therefore a no-op, and the same text can
//! never be stored twice.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::paths;

/// all-MiniLM-L6-v2 output width. A vector of any other length is a bug and
/// is rejected rather than silently stored.
pub const EMBED_DIM: usize = 384;

/// Query-time window: documents fetched within the last 3 years.
pub const RECENCY_WINDOW_DAYS: i64 = 365 * 3;

/// Metadata carried per chunk. Field names match v1's ChromaDB metadata so
/// the `/rag/documents` response shape is identical across both backends.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChunkMeta {
    #[serde(default)]
    pub source_url: String,
    #[serde(default)]
    pub document_title: String,
    #[serde(default)]
    pub document_type: String,
    #[serde(default)]
    pub cbdt_ref: String,
    #[serde(default)]
    pub effective_date: String,
    #[serde(default)]
    pub is_superseded: bool,
    #[serde(default)]
    pub superseded_by: String,
    /// ISO-8601 UTC. Compared lexically, which is correct for ISO-8601.
    #[serde(default)]
    pub date_fetched: String,
    #[serde(default)]
    pub page_number: u32,
    #[serde(default)]
    pub local_path: String,
}

/// A real path or URL: both separators are structural, keep them.
const PATH_SHAPED_FIELDS: [&str; 2] = ["local_path", "source_url"];

/// Descriptive, but may legitimately carry a forward slash. Indian tax
/// citations are *always* written "No. 1/2026", and the year after the
/// slash is what separates one circular from a different one carrying
/// the same number. The backslash is still stripped: these are prompt
/// text, never a path, so one only makes a value look like a path.
const SLASH_BEARING_FIELDS: [&str; 2] = ["cbdt_ref", "document_title"];
const MAX_META_STR_LEN: usize = 2000;

/// Strip NUL and C0 controls; strip path separators where a field never
/// needs one; cap length.
///
/// Metadata is echoed back into the model's context block, so a crafted
/// document title is untrusted input on the prompt path.
fn sanitise_meta_value(key: &str, value: &str) -> String {
    let mut cleaned: String = value
        .chars()
        .filter(|&c| c == '\t' || c == '\n' || c == '\r' || (c as u32) >= 0x20)
        .collect();
    if PATH_SHAPED_FIELDS.contains(&key) {
        // Structural separators; leave them alone.
    } else if SLASH_BEARING_FIELDS.contains(&key) {
        cleaned = cleaned.replace('\\', " ");
    } else {
        cleaned = cleaned.replace(['/', '\\'], " ");
    }
    cleaned.chars().take(MAX_META_STR_LEN).collect()
}

impl ChunkMeta {
    pub fn sanitised(mut self) -> Self {
        self.source_url = sanitise_meta_value("source_url", &self.source_url);
        self.document_title = sanitise_meta_value("document_title", &self.document_title);
        self.document_type = sanitise_meta_value("document_type", &self.document_type);
        self.cbdt_ref = sanitise_meta_value("cbdt_ref", &self.cbdt_ref);
        self.effective_date = sanitise_meta_value("effective_date", &self.effective_date);
        self.superseded_by = sanitise_meta_value("superseded_by", &self.superseded_by);
        self.date_fetched = sanitise_meta_value("date_fetched", &self.date_fetched);
        self.local_path = sanitise_meta_value("local_path", &self.local_path);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredChunk {
    pub id: String,
    pub text: String,
    #[serde(flatten)]
    pub meta: ChunkMeta,
}

/// One retrieval hit, shaped for the generate route's context block.
#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    pub text: String,
    pub cbdt_ref: String,
    pub document_title: String,
    pub document_type: String,
    pub page_number: u32,
    pub source_url: String,
    pub date_fetched: String,
    /// Cosine similarity; higher is better.
    pub score: f32,
}

#[derive(Debug, Serialize, Deserialize)]
struct Sidecar {
    /// Bumped if the on-disk layout changes, so an old store is discarded
    /// rather than misread.
    version: u32,
    dim: usize,
    chunks: Vec<StoredChunk>,
}

/// Stable content fingerprint, used as the chunk id.
pub fn content_hash(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

/// In-memory flat index, persisted to `rag/vectors-rs/`.
pub struct VectorStore {
    dir: PathBuf,
    /// Row-major, `EMBED_DIM` floats per chunk, parallel to `chunks`.
    vectors: Vec<f32>,
    chunks: Vec<StoredChunk>,
    /// id -> row, so an upsert of unchanged text is O(1).
    index: HashMap<String, usize>,
    dirty: bool,
}

const STORE_VERSION: u32 = 1;

impl VectorStore {
    pub fn open() -> Self {
        Self::open_at(paths::rag_vectors_dir())
    }

    /// Load from disk, or return an empty store.
    ///
    /// A corrupt or truncated store is treated as empty rather than fatal:
    /// the next sync re-ingests, and the request path must never 500 because
    /// of a bad RAG file.
    pub fn open_at(dir: PathBuf) -> Self {
        let mut store = Self {
            dir,
            vectors: Vec::new(),
            chunks: Vec::new(),
            index: HashMap::new(),
            dirty: false,
        };
        if let Err(e) = store.load() {
            tracing::warn!("vector store unreadable ({e}); starting empty");
            store.vectors.clear();
            store.chunks.clear();
            store.index.clear();
        }
        store
    }

    fn meta_path(&self) -> PathBuf {
        self.dir.join("meta.json")
    }
    fn vec_path(&self) -> PathBuf {
        self.dir.join("vectors.bin")
    }

    fn load(&mut self) -> Result<()> {
        let meta_path = self.meta_path();
        if !meta_path.exists() {
            return Ok(());
        }
        let text = std::fs::read_to_string(&meta_path)?;
        let sidecar: Sidecar = serde_json::from_str(&text)?;
        if sidecar.version != STORE_VERSION {
            bail!("store version {} is not {STORE_VERSION}", sidecar.version);
        }
        if sidecar.dim != EMBED_DIM {
            bail!("store dim {} is not {EMBED_DIM}", sidecar.dim);
        }
        let raw = std::fs::read(self.vec_path())?;
        let expected = sidecar.chunks.len() * EMBED_DIM * 4;
        if raw.len() != expected {
            bail!("vectors.bin is {} bytes, expected {expected}", raw.len());
        }
        let mut vectors = Vec::with_capacity(sidecar.chunks.len() * EMBED_DIM);
        for quad in raw.chunks_exact(4) {
            vectors.push(f32::from_le_bytes([quad[0], quad[1], quad[2], quad[3]]));
        }
        self.index = sidecar
            .chunks
            .iter()
            .enumerate()
            .map(|(i, c)| (c.id.clone(), i))
            .collect();
        self.chunks = sidecar.chunks;
        self.vectors = vectors;
        tracing::info!("vector store loaded: {} chunks", self.chunks.len());
        Ok(())
    }

    /// Persist. Both files are written to temporaries and renamed, so a kill
    /// mid-write leaves the previous store intact rather than a half-file.
    pub fn save(&mut self) -> Result<()> {
        if !self.dirty {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir)
            .with_context(|| format!("could not create {}", self.dir.display()))?;

        let vec_tmp = self.dir.join(format!("vectors.bin.tmp-{}", std::process::id()));
        {
            let file = std::fs::File::create(&vec_tmp)?;
            let mut w = std::io::BufWriter::new(file);
            for value in &self.vectors {
                w.write_all(&value.to_le_bytes())?;
            }
            w.flush()?;
        }

        let sidecar = Sidecar {
            version: STORE_VERSION,
            dim: EMBED_DIM,
            chunks: self.chunks.clone(),
        };
        let meta_tmp = self.dir.join(format!("meta.json.tmp-{}", std::process::id()));
        std::fs::write(&meta_tmp, serde_json::to_vec(&sidecar)?)?;

        // Vectors first: a sidecar listing chunks whose vectors are absent is
        // the one ordering that cannot be recovered from.
        std::fs::rename(&vec_tmp, self.vec_path())?;
        std::fs::rename(&meta_tmp, self.meta_path())?;
        self.dirty = false;
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.chunks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }

    pub fn chunks(&self) -> &[StoredChunk] {
        &self.chunks
    }

    /// Insert or replace a chunk. The vector must be unit-normalised.
    ///
    /// Returns true when the store changed. An id that already exists has its
    /// metadata refreshed (supersession state moves over time) but its vector
    /// is left alone — identical text embeds identically, so recomputing it
    /// would be wasted work.
    pub fn upsert(&mut self, id: String, text: String, meta: ChunkMeta, vector: &[f32]) -> Result<bool> {
        if vector.len() != EMBED_DIM {
            bail!("vector has {} dims, expected {EMBED_DIM}", vector.len());
        }
        let meta = meta.sanitised();
        if let Some(&row) = self.index.get(&id) {
            self.chunks[row].meta = meta;
            self.dirty = true;
            return Ok(false);
        }
        let row = self.chunks.len();
        self.chunks.push(StoredChunk { id: id.clone(), text, meta });
        self.vectors.extend_from_slice(&normalise(vector));
        self.index.insert(id, row);
        self.dirty = true;
        Ok(true)
    }

    /// Is a chunk with this id already stored?
    ///
    /// `index` is the authoritative id -> row map `upsert` maintains, so this
    /// is an O(1) hash probe. Callers that need to know what is already
    /// embedded must use this rather than rebuilding a set from `chunks()`:
    /// that rebuild is O(stored chunks) and the ingest path runs it once per
    /// document.
    pub fn contains_id(&self, id: &str) -> bool {
        self.index.contains_key(id)
    }

    /// Mark every chunk of a document as superseded.
    pub fn mark_superseded(&mut self, source_url: &str, superseded_by: &str) -> usize {
        let mut n = 0;
        for chunk in &mut self.chunks {
            if chunk.meta.source_url == source_url && !chunk.meta.is_superseded {
                chunk.meta.is_superseded = true;
                chunk.meta.superseded_by = sanitise_meta_value("superseded_by", superseded_by);
                n += 1;
            }
        }
        if n > 0 {
            self.dirty = true;
        }
        n
    }

    /// Top-`n` chunks by cosine similarity, filtered to the last 3 years and
    /// excluding superseded documents.
    ///
    /// Both filters are load-bearing: a superseded circular presented to the
    /// model as current law produces a confidently wrong citation, which is
    /// the one failure mode this whole pipeline exists to prevent. Unlike v1,
    /// the filter is applied in Rust before scoring, so there is no
    /// store-version fallback path that can silently drop it.
    pub fn query(&self, embedding: &[f32], n: usize) -> Vec<Hit> {
        if self.chunks.is_empty() || embedding.len() != EMBED_DIM || n == 0 {
            return Vec::new();
        }
        let probe = normalise(embedding);
        let cutoff = recency_cutoff_iso();

        let mut scored: Vec<(f32, usize)> = Vec::new();
        for (row, chunk) in self.chunks.iter().enumerate() {
            if chunk.meta.is_superseded {
                continue;
            }
            // Lexical compare is correct for ISO-8601. An absent timestamp is
            // kept: dropping it would hide a legitimately ingested document
            // because of a scraper metadata gap.
            if !chunk.meta.date_fetched.is_empty() && chunk.meta.date_fetched < cutoff {
                continue;
            }
            let base = row * EMBED_DIM;
            let score = dot(&probe, &self.vectors[base..base + EMBED_DIM]);
            scored.push((score, row));
        }
        // Partial sort: only the top n matter.
        scored.sort_unstable_by(|a, b| b.0.total_cmp(&a.0));
        scored
            .into_iter()
            .take(n)
            .map(|(score, row)| {
                let c = &self.chunks[row];
                Hit {
                    text: c.text.clone(),
                    cbdt_ref: c.meta.cbdt_ref.clone(),
                    document_title: c.meta.document_title.clone(),
                    document_type: c.meta.document_type.clone(),
                    page_number: c.meta.page_number,
                    source_url: c.meta.source_url.clone(),
                    date_fetched: c.meta.date_fetched.clone(),
                    score,
                }
            })
            .collect()
    }

    /// Drop everything, on disk included.
    pub fn clear(&mut self) -> Result<()> {
        self.vectors.clear();
        self.chunks.clear();
        self.index.clear();
        self.dirty = true;
        let _ = std::fs::remove_file(self.vec_path());
        let _ = std::fs::remove_file(self.meta_path());
        self.dirty = false;
        Ok(())
    }

    pub fn superseded_count(&self) -> usize {
        self.chunks.iter().filter(|c| c.meta.is_superseded).count()
    }
}

fn recency_cutoff_iso() -> String {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(RECENCY_WINDOW_DAYS);
    cutoff.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
}

/// Unit-normalise so cosine similarity is a plain dot product.
fn normalise(v: &[f32]) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm <= f32::EPSILON {
        return v.to_vec();
    }
    v.iter().map(|x| x / norm).collect()
}

/// Dot product, chunked by 8 so the compiler can vectorise it.
fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = [0f32; 8];
    let mut i = 0;
    while i + 8 <= a.len() {
        for k in 0..8 {
            acc[k] += a[i + k] * b[i + k];
        }
        i += 8;
    }
    let mut sum: f32 = acc.iter().sum();
    while i < a.len() {
        sum += a[i] * b[i];
        i += 1;
    }
    sum
}

/// Paragraph-aware chunking, ~512 words per chunk with 50 words of overlap.
///
/// Ported from v1. "Tokens" are approximated as whitespace-separated words —
/// close enough for the model's 256-piece WordPiece tokeniser and far simpler
/// than running the real tokeniser at chunk time.
pub fn chunk_text(text: &str, max_tokens: usize, overlap: usize) -> Vec<String> {
    let paras: Vec<&str> = text
        .split("\n\n")
        .flat_map(|block| block.split("\r\n\r\n"))
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if paras.is_empty() || max_tokens == 0 {
        return Vec::new();
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut current: Vec<String> = Vec::new();

    for para in paras {
        let words: Vec<String> = para.split_whitespace().map(str::to_string).collect();
        if words.is_empty() {
            continue;
        }

        if words.len() > max_tokens {
            // Long paragraph: flush the buffer, then emit hard windows.
            if !current.is_empty() {
                chunks.push(current.join(" "));
                current.clear();
            }
            let step = if max_tokens > overlap { max_tokens - overlap } else { max_tokens };
            let mut start = 0;
            while start < words.len() {
                let end = (start + max_tokens).min(words.len());
                chunks.push(words[start..end].join(" "));
                if end >= words.len() {
                    break;
                }
                start += step;
            }
            continue;
        }

        if current.len() + words.len() > max_tokens {
            chunks.push(current.join(" "));
            // Carry the tail forward so context bridges the boundary.
            let tail_start = current.len().saturating_sub(overlap);
            let tail: Vec<String> = current[tail_start..].to_vec();
            current = tail;
            current.extend(words);
        } else {
            current.extend(words);
        }
    }
    if !current.is_empty() {
        chunks.push(current.join(" "));
    }
    chunks.retain(|c| !c.trim().is_empty());
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(seed: f32) -> Vec<f32> {
        let v: Vec<f32> = (0..EMBED_DIM).map(|i| ((i as f32) * seed).sin()).collect();
        normalise(&v)
    }

    fn meta(url: &str, fetched: &str) -> ChunkMeta {
        ChunkMeta {
            source_url: url.into(),
            document_title: "Test Circular".into(),
            document_type: "circular".into(),
            cbdt_ref: "Circular No. 1/2026".into(),
            date_fetched: fetched.into(),
            page_number: 1,
            ..Default::default()
        }
    }

    fn recent() -> String {
        chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S+00:00")
            .to_string()
    }

    #[test]
    fn identical_text_is_one_chunk_not_two() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = VectorStore::open_at(dir.path().to_path_buf());
        let text = "Section 194-I applies to rent paid to a resident.";
        let id = content_hash(text);
        assert!(s.upsert(id.clone(), text.into(), meta("u", &recent()), &unit(0.1)).unwrap());
        // Second upsert of the same content hash must not add a row.
        assert!(!s.upsert(id, text.into(), meta("u", &recent()), &unit(0.1)).unwrap());
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn a_wrong_width_vector_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = VectorStore::open_at(dir.path().to_path_buf());
        assert!(s.upsert("x".into(), "t".into(), ChunkMeta::default(), &[0.0; 8]).is_err());
        assert_eq!(s.len(), 0);
    }

    #[test]
    fn superseded_chunks_never_surface() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = VectorStore::open_at(dir.path().to_path_buf());
        let v = unit(0.2);
        s.upsert("a".into(), "old law".into(), meta("old", &recent()), &v).unwrap();
        assert_eq!(s.query(&v, 5).len(), 1);
        assert_eq!(s.mark_superseded("old", "Circular No. 9/2026"), 1);
        assert!(
            s.query(&v, 5).is_empty(),
            "a superseded circular must never reach the model"
        );
        assert_eq!(s.superseded_count(), 1);
    }

    #[test]
    fn documents_older_than_three_years_are_filtered() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = VectorStore::open_at(dir.path().to_path_buf());
        let v = unit(0.3);
        s.upsert("old".into(), "ancient".into(), meta("o", "2015-01-01T00:00:00+00:00"), &v)
            .unwrap();
        s.upsert("new".into(), "current".into(), meta("n", &recent()), &unit(0.31))
            .unwrap();
        let hits = s.query(&v, 5);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "current");
    }

    #[test]
    fn a_missing_timestamp_is_kept_not_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = VectorStore::open_at(dir.path().to_path_buf());
        let v = unit(0.4);
        s.upsert("x".into(), "no date".into(), meta("u", ""), &v).unwrap();
        assert_eq!(s.query(&v, 5).len(), 1);
    }

    #[test]
    fn best_match_ranks_first() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = VectorStore::open_at(dir.path().to_path_buf());
        let target = unit(0.5);
        s.upsert("far".into(), "far".into(), meta("a", &recent()), &unit(2.7)).unwrap();
        s.upsert("near".into(), "near".into(), meta("b", &recent()), &target).unwrap();
        let hits = s.query(&target, 2);
        assert_eq!(hits[0].text, "near");
        assert!(hits[0].score > hits[1].score);
        assert!((hits[0].score - 1.0).abs() < 1e-4, "self-match should be ~1.0");
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let v = unit(0.6);
        {
            let mut s = VectorStore::open_at(dir.path().to_path_buf());
            s.upsert("a".into(), "Rule 11UA valuation".into(), meta("u", &recent()), &v)
                .unwrap();
            s.save().unwrap();
        }
        let s = VectorStore::open_at(dir.path().to_path_buf());
        assert_eq!(s.len(), 1);
        let hits = s.query(&v, 1);
        assert_eq!(hits[0].text, "Rule 11UA valuation");
        assert_eq!(hits[0].cbdt_ref, "Circular No. 1/2026");
    }

    #[test]
    fn a_truncated_vectors_file_yields_an_empty_store_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut s = VectorStore::open_at(dir.path().to_path_buf());
            s.upsert("a".into(), "t".into(), meta("u", &recent()), &unit(0.7)).unwrap();
            s.save().unwrap();
        }
        std::fs::write(dir.path().join("vectors.bin"), b"short").unwrap();
        let s = VectorStore::open_at(dir.path().to_path_buf());
        assert!(s.is_empty(), "a corrupt store must degrade, not crash");
    }

    #[test]
    fn metadata_is_sanitised_before_it_reaches_the_prompt() {
        let m = ChunkMeta {
            document_title: "Evil\0Title/with\\seps".into(),
            local_path: r"C:\data\file.pdf".into(),
            source_url: "https://x/y.pdf".into(),
            ..Default::default()
        }
        .sanitised();
        assert!(!m.document_title.contains('\0'));
        // A backslash never belongs in a title: it is what makes a
        // value read as a path. The forward slash stays, because a
        // citation needs it.
        assert!(!m.document_title.contains('\\'));
        // Path-shaped fields keep both separators.
        assert!(m.local_path.contains('\\'));
        assert!(m.source_url.contains('/'));
    }

    #[test]
    fn a_citation_keeps_its_slash() {
        // "Circular No. 1/2026" and "Circular No. 1/2019" are different
        // circulars. Collapsing the slash makes a cited authority
        // ambiguous - the one failure mode the whole retrieval pipeline
        // exists to prevent.
        let m = ChunkMeta {
            cbdt_ref: "Circular No. 1/2026".into(),
            document_title: "Notification No. 15/2026 - TDS on rent".into(),
            ..Default::default()
        }
        .sanitised();
        assert_eq!(m.cbdt_ref, "Circular No. 1/2026");
        assert_eq!(m.document_title, "Notification No. 15/2026 - TDS on rent");
    }

    #[test]
    fn long_metadata_is_capped() {
        let m = ChunkMeta { document_title: "a".repeat(5000), ..Default::default() }.sanitised();
        assert_eq!(m.document_title.len(), MAX_META_STR_LEN);
    }

    #[test]
    fn chunking_packs_paragraphs_and_overlaps() {
        let text = "alpha beta gamma\n\ndelta epsilon zeta";
        let chunks = chunk_text(text, 512, 50);
        assert_eq!(chunks.len(), 1, "short paragraphs pack into one chunk");
        assert_eq!(chunks[0], "alpha beta gamma delta epsilon zeta");
    }

    #[test]
    fn a_long_paragraph_is_windowed_with_overlap() {
        let words: Vec<String> = (0..1200).map(|i| format!("w{i}")).collect();
        let chunks = chunk_text(&words.join(" "), 512, 50);
        assert!(chunks.len() >= 3, "got {} chunks", chunks.len());
        // Consecutive windows must share the overlap, or a citation split
        // across a boundary becomes unretrievable.
        let first_tail: Vec<&str> = chunks[0].split_whitespace().rev().take(50).collect();
        let second_head: Vec<&str> = chunks[1].split_whitespace().take(50).collect();
        assert!(
            first_tail.iter().any(|w| second_head.contains(w)),
            "windows must overlap"
        );
    }

    #[test]
    fn chunking_handles_degenerate_input() {
        assert!(chunk_text("", 512, 50).is_empty());
        assert!(chunk_text("   \n\n  \n\n ", 512, 50).is_empty());
        assert!(chunk_text("text", 0, 50).is_empty());
    }

    #[test]
    fn chunking_terminates_when_overlap_exceeds_the_window() {
        // A misconfigured overlap must not loop forever.
        let words: Vec<String> = (0..300).map(|i| format!("w{i}")).collect();
        let chunks = chunk_text(&words.join(" "), 100, 500);
        assert!(!chunks.is_empty());
        assert!(chunks.len() < 100);
    }

    #[test]
    fn query_on_an_empty_store_is_empty_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let s = VectorStore::open_at(dir.path().to_path_buf());
        assert!(s.query(&unit(0.8), 5).is_empty());
    }

    #[test]
    fn clear_removes_the_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = VectorStore::open_at(dir.path().to_path_buf());
        s.upsert("a".into(), "t".into(), meta("u", &recent()), &unit(0.9)).unwrap();
        s.save().unwrap();
        assert!(dir.path().join("meta.json").exists());
        s.clear().unwrap();
        assert!(!dir.path().join("meta.json").exists());
        assert!(s.is_empty());
    }

    #[test]
    fn dot_matches_a_naive_sum() {
        let a: Vec<f32> = (0..EMBED_DIM).map(|i| i as f32 * 0.01).collect();
        let b: Vec<f32> = (0..EMBED_DIM).map(|i| (i as f32).cos()).collect();
        let naive: f32 = a.iter().zip(&b).map(|(x, y)| x * y).sum();
        assert!((dot(&a, &b) - naive).abs() < 1e-2);
    }
}
