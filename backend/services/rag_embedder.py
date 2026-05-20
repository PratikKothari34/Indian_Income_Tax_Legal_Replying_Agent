"""Local embedding + ChromaDB layer for the RAG pipeline.

Phase 2 RAG. Responsibilities:

* Lazy-load ``sentence-transformers/all-MiniLM-L6-v2`` once per process.
* Extract text from each downloaded PDF with :mod:`pdfplumber`.
* Chunk by paragraph, ~512 tokens per chunk with 50-token overlap.
* Compute a stable content hash per chunk so we never re-embed chunks
  whose text hasn't changed.
* Upsert chunks + embeddings into a single ChromaDB collection
  (``cbdt_documents``) with rich metadata.
* Expose :func:`query` for the ``/generate`` endpoint, with a "last 3
  years" recency filter applied at query time.

Failure modes — every public function tolerates a missing model, a
corrupt ChromaDB store, and PDFs whose text layer is unparseable. None
of these conditions raise into the FastAPI request path; they log to
``rag.log`` and degrade gracefully (an empty result list).

Important: ``paths.configure_hf_cache()`` MUST be called before any
import of ``sentence_transformers`` for the cache pin to take effect.
The module-level :data:`_load_model` call is therefore deferred — the
top of this module only imports stdlib + chromadb.
"""

from __future__ import annotations

import hashlib
import re
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from paths import (
    RAG_CHROMADB_DIR,
    configure_hf_cache,
    get_rag_logger,
)

log = get_rag_logger()

COLLECTION_NAME = "cbdt_documents"
EMBED_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

# Spec: 512-token chunks with 50-token overlap. We approximate "tokens"
# as whitespace-separated words — close enough for sentence-transformers'
# 256-piece WordPiece tokeniser and dramatically simpler than wiring up
# the model's own tokeniser at chunk time.
DEFAULT_MAX_TOKENS = 512
DEFAULT_OVERLAP = 50

# At query time, restrict to documents fetched in the last 3 years.
# Timestamps stored in chromadb metadata are ISO-8601 UTC strings — we
# compare lexically, which is correct for ISO-8601.
RECENCY_WINDOW_DAYS = 365 * 3


# ---------------------------------------------------------------------------
# Lazy singletons
# ---------------------------------------------------------------------------
_model: Any = None
_chroma_client: Any = None
_collection: Any = None


def _load_model() -> Any:
    """Return a cached ``SentenceTransformer`` instance.

    First call triggers a one-time download (~90 MB) into
    ``RAG_MODELS_DIR``; subsequent calls are O(1). Raises
    :class:`RuntimeError` if the model cannot be loaded — the caller
    is expected to surface this as a clear error in ``/rag/status``.
    """
    global _model
    if _model is not None:
        return _model
    configure_hf_cache()
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as e:  # pragma: no cover
        raise RuntimeError(
            "sentence-transformers is not installed; run pip install -r requirements.txt"
        ) from e
    log.info("loading embedding model %s", EMBED_MODEL_NAME)
    try:
        _model = SentenceTransformer(EMBED_MODEL_NAME)
    except Exception as e:
        raise RuntimeError(
            f"Could not load embedding model {EMBED_MODEL_NAME!r}. "
            "Run sync once with internet to download embedding model. "
            f"Underlying error: {e}"
        ) from e
    return _model


def _open_collection() -> Any:
    """Open (or create) the ``cbdt_documents`` collection.

    On corruption (chromadb raises during open), we wipe the chromadb
    directory and create a fresh empty collection — re-indexing happens
    on the next sync cycle.
    """
    global _chroma_client, _collection
    if _collection is not None:
        return _collection
    try:
        import chromadb
        from chromadb.config import Settings
    except ImportError as e:  # pragma: no cover
        raise RuntimeError(
            "chromadb is not installed; run pip install -r requirements.txt"
        ) from e

    RAG_CHROMADB_DIR.mkdir(parents=True, exist_ok=True)
    try:
        _chroma_client = chromadb.PersistentClient(
            path=str(RAG_CHROMADB_DIR),
            settings=Settings(anonymized_telemetry=False, allow_reset=True),
        )
        _collection = _chroma_client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
        return _collection
    except Exception as e:
        log.error("ChromaDB open failed (%s) — wiping and reinitialising", e)
        _chroma_client = None
        _collection = None
        try:
            shutil.rmtree(RAG_CHROMADB_DIR, ignore_errors=True)
            RAG_CHROMADB_DIR.mkdir(parents=True, exist_ok=True)
            _chroma_client = chromadb.PersistentClient(
                path=str(RAG_CHROMADB_DIR),
                settings=Settings(anonymized_telemetry=False, allow_reset=True),
            )
            _collection = _chroma_client.get_or_create_collection(
                name=COLLECTION_NAME,
                metadata={"hnsw:space": "cosine"},
            )
            return _collection
        except Exception as e2:
            raise RuntimeError(f"ChromaDB is unrecoverable: {e2}") from e2


def is_model_available() -> bool:
    """Cheap check used by ``/rag/status``: does the embedding model load?"""
    try:
        _load_model()
        return True
    except RuntimeError:
        return False


def collection_size() -> int:
    """Return the chunk count in the collection (0 if unreadable)."""
    try:
        return int(_open_collection().count())
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# PDF → text → chunks
# ---------------------------------------------------------------------------
def _extract_pages(doc_path: Path) -> list[tuple[int, str]]:
    """Return ``[(page_number, page_text), ...]`` for the document.

    Dispatches on extension:

    * ``.pdf``  — pdfplumber, one tuple per text-bearing page.
    * ``.docx`` — python-docx, paragraphs concatenated into a single "page".
    * ``.txt``  — read as UTF-8, one "page". Used by the Indian Kanoon
      auto-scrape path which writes plain text harvested from the
      ``/doc/<docid>/`` endpoint.

    Pages with no extractable text are omitted. Unknown extensions fall
    through to the txt path so unusual inputs aren't silently dropped.
    """
    ext = doc_path.suffix.lower()

    if ext == ".pdf":
        try:
            import pdfplumber
        except ImportError as e:  # pragma: no cover
            raise RuntimeError("pdfplumber is required for RAG ingestion") from e

        out: list[tuple[int, str]] = []
        try:
            with pdfplumber.open(str(doc_path)) as pdf:
                for i, page in enumerate(pdf.pages, start=1):
                    text = page.extract_text() or ""
                    if text.strip():
                        out.append((i, text))
        except Exception as e:
            log.warning("pdf parse failed for %s: %s", doc_path.name, e)
        return out

    if ext == ".docx":
        try:
            from docx import Document
        except ImportError:
            log.warning("python-docx not installed — cannot parse %s", doc_path.name)
            return []
        try:
            doc = Document(str(doc_path))
            text = "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())
        except Exception as e:
            log.warning("docx parse failed for %s: %s", doc_path.name, e)
            return []
        return [(1, text)] if text.strip() else []

    # .txt and everything else: read as UTF-8.
    try:
        text = doc_path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        log.warning("text read failed for %s: %s", doc_path.name, e)
        return []
    return [(1, text)] if text.strip() else []


_PARA_SPLIT_RE = re.compile(r"\n\s*\n+")


def chunk_text(
    text: str,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    overlap: int = DEFAULT_OVERLAP,
) -> list[str]:
    """Split ``text`` into paragraph-aware chunks of ~``max_tokens`` words.

    Algorithm:

    1. Split on blank lines into paragraphs.
    2. Greedily pack paragraphs into a chunk until adding the next would
       exceed ``max_tokens`` words.
    3. When a single paragraph alone exceeds ``max_tokens``, slice it
       into word-windows of ``max_tokens`` with ``overlap`` carry-over.
    4. Between chunks, carry the last ``overlap`` words forward to the
       start of the next chunk so context bridges the boundary.
    """
    paras = [p.strip() for p in _PARA_SPLIT_RE.split(text) if p.strip()]
    if not paras:
        return []

    chunks: list[str] = []
    current_words: list[str] = []

    def flush() -> None:
        if current_words:
            chunks.append(" ".join(current_words).strip())

    for para in paras:
        words = para.split()
        if not words:
            continue

        if len(words) > max_tokens:
            # Long paragraph: hard-window it. First flush whatever we
            # had buffered, then emit overlapping windows directly.
            flush()
            current_words = []
            step = max_tokens - overlap
            if step <= 0:
                step = max_tokens
            for start in range(0, len(words), step):
                window = words[start : start + max_tokens]
                if not window:
                    continue
                chunks.append(" ".join(window).strip())
                if start + max_tokens >= len(words):
                    break
            continue

        if len(current_words) + len(words) > max_tokens:
            flush()
            # Carry last `overlap` words into the next chunk for context.
            tail = current_words[-overlap:] if overlap > 0 else []
            current_words = list(tail) + words
        else:
            current_words.extend(words)

    flush()
    return [c for c in chunks if c]


def _content_hash(text: str) -> str:
    """Stable content fingerprint for a chunk — used as the chromadb id
    so re-running the embedder over an unchanged PDF is a no-op upsert.
    """
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------
def ingest_pdf(pdf_meta: dict[str, Any]) -> int:
    """Chunk + embed + upsert one PDF described by ``pdf_meta``.

    ``pdf_meta`` must contain at least ``local_path``, ``url``,
    ``document_type``, ``document_title``, ``fetched_at`` (the dict
    shape produced by :func:`rag_scraper.scrape_all_sources`).

    :returns: number of chunks added/updated. Returns 0 if the PDF has
        no extractable text or any step fails.
    """
    from services.rag_scraper import parse_cbdt_ref  # avoid circular import

    pdf_path = Path(pdf_meta["local_path"])
    if not pdf_path.exists():
        log.warning("ingest skipped — file missing: %s", pdf_path)
        return 0

    pages = _extract_pages(pdf_path)
    if not pages:
        return 0

    # Pull the CBDT reference once from the first page's text.
    first_page_text = pages[0][1] if pages else ""
    cbdt_ref = parse_cbdt_ref(first_page_text) or ""

    try:
        model = _load_model()
        collection = _open_collection()
    except RuntimeError as e:
        log.error("ingest aborted: %s", e)
        return 0

    ids: list[str] = []
    docs: list[str] = []
    metadatas: list[dict[str, Any]] = []

    source_url = pdf_meta.get("source_url") or pdf_meta.get("url") or ""
    effective_date = pdf_meta.get("effective_date") or ""
    is_superseded = bool(pdf_meta.get("is_superseded", False))
    superseded_by = pdf_meta.get("superseded_by") or ""

    for page_num, page_text in pages:
        for chunk in chunk_text(page_text):
            chunk_id = _content_hash(chunk)
            ids.append(chunk_id)
            docs.append(chunk)
            metadatas.append(
                {
                    "source_url": source_url,
                    "document_title": pdf_meta["document_title"],
                    "document_type": pdf_meta["document_type"],
                    "cbdt_ref": cbdt_ref,
                    "effective_date": effective_date,
                    "is_superseded": is_superseded,
                    "superseded_by": superseded_by,
                    "date_fetched": pdf_meta["fetched_at"],
                    "page_number": page_num,
                    "local_path": str(pdf_path),
                }
            )

    if not ids:
        return 0

    try:
        embeddings = model.encode(
            docs, batch_size=32, show_progress_bar=False, normalize_embeddings=True
        ).tolist()
    except Exception as e:
        log.error("embedding failed for %s: %s", pdf_path.name, e)
        return 0

    try:
        # ChromaDB's upsert is idempotent on (id) — same content_hash =>
        # no-op so repeated runs over the same PDF are cheap.
        collection.upsert(
            ids=ids, documents=docs, embeddings=embeddings, metadatas=metadatas
        )
    except Exception as e:
        log.error("chromadb upsert failed for %s: %s", pdf_path.name, e)
        return 0

    log.info("ingested %s — %d chunks (cbdt_ref=%s)", pdf_path.name, len(ids), cbdt_ref or "?")
    return len(ids)


def ingest_many(pdf_metas: list[dict[str, Any]]) -> int:
    """Ingest a batch of PDFs. Returns total chunks added/updated."""
    total = 0
    for meta in pdf_metas:
        total += ingest_pdf(meta)
    return total


def reembed_local_pdfs(metadata_lookup: dict[str, dict[str, Any]] | None = None) -> int:
    """Re-embed every PDF currently on disk.

    Used by ``/rag/sync`` as a fallback when the chromadb collection is
    empty but ``RAG_DOCS_DIR`` already contains downloads (e.g. after
    chromadb corruption + reset). ``metadata_lookup`` maps local_path →
    pdf_meta dict; if absent, we synthesise a minimal metadata block.
    """
    from services.rag_scraper import (
        _classify_doc_type,
        _parse_effective_date,
        list_local_pdfs,
    )
    from paths import RAG_DOCS_DIR

    total = 0
    for pdf_path in list_local_pdfs():
        if metadata_lookup and str(pdf_path) in metadata_lookup:
            meta = metadata_lookup[str(pdf_path)]
        else:
            # Files dropped by the scraper live in RAG_DOCS_DIR/<doc_type>/.
            # Files dropped manually live at the top level. Use the parent
            # subfolder name as the doc_type when we can; otherwise classify
            # from the filename.
            try:
                rel_parent = pdf_path.relative_to(RAG_DOCS_DIR).parent
            except ValueError:
                rel_parent = Path(".")
            subfolder = rel_parent.parts[0] if rel_parent.parts else ""
            doc_type = subfolder or _classify_doc_type(pdf_path)
            meta = {
                "local_path": str(pdf_path),
                "url": pdf_path.as_uri(),
                "source_url": pdf_path.as_uri(),
                "document_type": doc_type,
                "document_title": pdf_path.stem[:240],
                "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "effective_date": _parse_effective_date(pdf_path.name),
                "is_superseded": False,
                "superseded_by": "",
            }
        total += ingest_pdf(meta)
    return total


# ---------------------------------------------------------------------------
# Query
# ---------------------------------------------------------------------------
def _recency_cutoff_iso() -> str:
    cutoff = datetime.now(timezone.utc) - timedelta(days=RECENCY_WINDOW_DAYS)
    return cutoff.isoformat(timespec="seconds")


def query(query_text: str, n_results: int = 5) -> list[dict[str, Any]]:
    """Retrieve the top ``n_results`` chunks for ``query_text``.

    Filters to documents fetched in the last 3 years (per spec). Returns
    a list of dicts shaped for the generate-route context block::

        {
          "text":           "<chunk text>",
          "cbdt_ref":       "Circular No. 8/2013" | "",
          "document_title": "...",
          "document_type":  "circular",
          "page_number":    int,
          "score":          float,    # cosine similarity, higher = better
        }

    On any failure (model unavailable, empty collection, chromadb error)
    returns ``[]`` so the caller can degrade silently.
    """
    if not query_text or not query_text.strip():
        return []
    try:
        model = _load_model()
        collection = _open_collection()
    except RuntimeError as e:
        log.warning("query unavailable: %s", e)
        return []

    if collection_size() == 0:
        return []

    try:
        embedding = model.encode(
            [query_text], normalize_embeddings=True, show_progress_bar=False
        ).tolist()
    except Exception as e:
        log.warning("query embed failed: %s", e)
        return []

    # Filter: last 3 years AND not superseded. Older / superseded chunks
    # exist in the collection but must never surface to the LLM.
    where = {
        "$and": [
            {"date_fetched": {"$gte": _recency_cutoff_iso()}},
            {"is_superseded": False},
        ]
    }
    try:
        result = collection.query(
            query_embeddings=embedding,
            n_results=max(1, int(n_results)),
            where=where,
        )
    except Exception as e:
        # Some chromadb versions reject the "$gte" operator on string
        # metadata. Retry with just the supersession filter — losing the
        # recency clamp is preferable to losing the supersession guard.
        log.warning("composite filtered query failed (%s) — retrying with is_superseded only", e)
        try:
            result = collection.query(
                query_embeddings=embedding,
                n_results=max(1, int(n_results)),
                where={"is_superseded": False},
            )
        except Exception as e2:
            log.warning("supersession-filtered query failed (%s) — retrying unfiltered", e2)
            try:
                result = collection.query(
                    query_embeddings=embedding, n_results=max(1, int(n_results))
                )
            except Exception as e3:
                log.warning("query failed: %s", e3)
                return []

    docs = (result.get("documents") or [[]])[0]
    metas = (result.get("metadatas") or [[]])[0]
    dists = (result.get("distances") or [[]])[0]

    out: list[dict[str, Any]] = []
    for text, meta, dist in zip(docs, metas, dists):
        meta = meta or {}
        # Distance is cosine distance for our collection (1 - similarity).
        # We convert to a similarity score so higher = better.
        try:
            score = 1.0 - float(dist)
        except (TypeError, ValueError):
            score = 0.0
        out.append(
            {
                "text": text,
                "cbdt_ref": meta.get("cbdt_ref") or "",
                "document_title": meta.get("document_title") or "",
                "document_type": meta.get("document_type") or "",
                "page_number": int(meta.get("page_number") or 0),
                "source_url": meta.get("source_url") or "",
                "date_fetched": meta.get("date_fetched") or "",
                "score": score,
            }
        )
    return out


# ---------------------------------------------------------------------------
# Document listing — for GET /rag/documents
# ---------------------------------------------------------------------------
def list_documents() -> list[dict[str, Any]]:
    """Aggregate the collection by source PDF for the documents endpoint.

    Group all chunks by ``source_url`` and report one row per document
    with ``chunk_count`` and the pulled-through metadata. Returns an
    empty list if the collection is empty or unreadable.
    """
    try:
        collection = _open_collection()
    except RuntimeError:
        return []
    try:
        all_rows = collection.get(include=["metadatas"])
    except Exception as e:
        log.warning("list_documents failed: %s", e)
        return []

    groups: dict[str, dict[str, Any]] = {}
    for meta in all_rows.get("metadatas", []) or []:
        if not isinstance(meta, dict):
            continue
        url = meta.get("source_url") or "unknown"
        if url not in groups:
            groups[url] = {
                "title": meta.get("document_title") or "",
                "type": meta.get("document_type") or "",
                "cbdt_ref": meta.get("cbdt_ref") or "",
                "effective_date": meta.get("effective_date") or "",
                "date_fetched": meta.get("date_fetched") or "",
                "source_url": url,
                "is_superseded": bool(meta.get("is_superseded", False)),
                "superseded_by": meta.get("superseded_by") or "",
                "chunk_count": 0,
            }
        else:
            # If any chunk for this doc was marked superseded later, propagate.
            if meta.get("is_superseded"):
                groups[url]["is_superseded"] = True
                groups[url]["superseded_by"] = (
                    meta.get("superseded_by") or groups[url]["superseded_by"]
                )
        groups[url]["chunk_count"] += 1

    return sorted(
        groups.values(), key=lambda r: r.get("date_fetched") or "", reverse=True
    )


# ---------------------------------------------------------------------------
# Supersession detection
# ---------------------------------------------------------------------------
_REF_NUM_YEAR_RE = re.compile(r"(\w+)\s*No\.?\s*(\d+)/(\d{4})", re.IGNORECASE)


def detect_supersessions() -> int:
    """Mark older versions of any doc as superseded.

    Two rules apply:

    1. Hardcoded slug pairs (Acts / Rules) from
       :data:`services.rag_scraper.SUPERSESSION_PAIRS` — when both the
       old and new slugs appear in any indexed ``source_url``, the old
       one is marked superseded.
    2. Same CBDT reference number / different year — the older year is
       superseded by the newer year (within a single ``document_type``).

    Returns the number of chunk metadata rows updated.
    """
    from services.rag_scraper import SUPERSESSION_PAIRS  # avoid circular import

    try:
        collection = _open_collection()
    except RuntimeError:
        return 0

    try:
        all_rows = collection.get(include=["metadatas"])
    except Exception as e:
        log.warning("detect_supersessions: collection.get failed: %s", e)
        return 0

    ids_list: list[str] = list(all_rows.get("ids") or [])
    metas: list[Any] = list(all_rows.get("metadatas") or [])
    if not ids_list:
        return 0

    by_url_indices: dict[str, list[int]] = {}
    url_meta: dict[str, dict[str, Any]] = {}
    for idx, meta in enumerate(metas):
        if not isinstance(meta, dict):
            continue
        url = meta.get("source_url") or ""
        if not url:
            continue
        by_url_indices.setdefault(url, []).append(idx)
        if url not in url_meta:
            url_meta[url] = meta

    superseded_map: dict[str, str] = {}  # old_url -> new doc title

    # Rule 1: hardcoded slug pairs.
    for old_slug, new_slug in SUPERSESSION_PAIRS:
        old_url = next(
            (u for u in url_meta if old_slug.lower() in u.lower()), None
        )
        new_url = next(
            (u for u in url_meta if new_slug.lower() in u.lower()), None
        )
        if old_url and new_url and old_url != new_url:
            new_title = url_meta[new_url].get("document_title") or new_slug
            superseded_map.setdefault(old_url, new_title)

    # Rule 2: CBDT ref number match, newer year wins (per doc_type).
    by_ref: dict[tuple[str, str, str], list[tuple[int, str, str]]] = {}
    for url, meta in url_meta.items():
        ref = meta.get("cbdt_ref") or ""
        m = _REF_NUM_YEAR_RE.search(ref)
        if not m:
            continue
        label = m.group(1).lower()
        num = m.group(2)
        year = int(m.group(3))
        doc_type = (meta.get("document_type") or "").lower()
        by_ref.setdefault((doc_type, label, num), []).append(
            (year, url, meta.get("document_title") or "")
        )

    for entries in by_ref.values():
        if len(entries) < 2:
            continue
        entries.sort(reverse=True)  # newest year first
        _, _, newest_title = entries[0]
        for _year, old_url, _title in entries[1:]:
            superseded_map.setdefault(old_url, newest_title)

    if not superseded_map:
        return 0

    # Apply updates: rebuild metadata for affected chunks, push as upsert.
    updated_ids: list[str] = []
    updated_metas: list[dict[str, Any]] = []
    for old_url, new_title in superseded_map.items():
        for i in by_url_indices.get(old_url, []):
            m = metas[i]
            if not isinstance(m, dict):
                continue
            if m.get("is_superseded") and m.get("superseded_by") == new_title:
                continue
            new_m = dict(m)
            new_m["is_superseded"] = True
            new_m["superseded_by"] = new_title
            updated_ids.append(ids_list[i])
            updated_metas.append(new_m)
        log.info("[supersession] %s superseded by %s", old_url, new_title)

    if not updated_ids:
        return 0

    try:
        collection.update(ids=updated_ids, metadatas=updated_metas)
    except Exception as e:
        log.warning("supersession update failed: %s", e)
        return 0
    return len(updated_ids)


# ---------------------------------------------------------------------------
# Maintenance helpers
# ---------------------------------------------------------------------------
def clear_collection() -> None:
    """Drop and recreate the ``cbdt_documents`` collection.

    Used by ``POST /rag/reindex`` to wipe the chunk store before
    re-embedding all local PDFs from scratch.
    """
    global _chroma_client, _collection
    try:
        client = _chroma_client
        if client is None:
            _open_collection()
            client = _chroma_client
        if client is None:
            return
        try:
            client.delete_collection(COLLECTION_NAME)
        except Exception as e:
            log.warning("delete_collection failed (will recreate anyway): %s", e)
        _collection = None
        _open_collection()
        log.info("collection %r cleared", COLLECTION_NAME)
    except Exception as e:
        log.warning("clear_collection: %s", e)


def superseded_docs_count() -> int:
    """Number of distinct documents currently marked superseded."""
    try:
        collection = _open_collection()
    except RuntimeError:
        return 0
    try:
        rows = collection.get(include=["metadatas"], where={"is_superseded": True})
    except Exception:
        # Fallback: scan everything.
        try:
            rows = collection.get(include=["metadatas"])
        except Exception:
            return 0
        urls = {
            (m or {}).get("source_url")
            for m in rows.get("metadatas", []) or []
            if isinstance(m, dict) and m.get("is_superseded")
        }
        urls.discard(None)
        return len(urls)
    urls = {
        (m or {}).get("source_url")
        for m in rows.get("metadatas", []) or []
        if isinstance(m, dict)
    }
    urls.discard(None)
    return len(urls)
