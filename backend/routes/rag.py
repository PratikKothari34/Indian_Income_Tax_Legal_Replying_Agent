"""``/rag/*`` endpoints — status, manual sync, document listing, reindex.

Phase 2 RAG. Routes:

* ``GET  /rag/status``        — sync timestamps, totals, supersession count.
* ``POST /rag/sync``          — fire-and-forget manual sync trigger.
* ``GET  /rag/documents``     — list of indexed documents (incl. supersession flags).
* ``GET  /rag/docs-folder``   — absolute path of the manual-ingest folder.
* ``POST /rag/reindex``       — wipe chromadb and re-embed every local PDF.

The heavy work (sync, reindex) runs as a background asyncio task so the
HTTP handler returns immediately.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter

from paths import RAG_DOCS_DIR
from services import rag_embedder, rag_scheduler

router = APIRouter(prefix="/rag", tags=["rag"])


@router.get("/status")
def rag_status() -> dict[str, Any]:
    """Return persisted sync status + next scheduled run + model availability.

    The ``embedding_model_available`` flag is the cheap "did the
    sentence-transformers model load?" check from the embedder. When
    it is ``False`` and ``last_sync_status == "never"``, the frontend
    should surface the spec'd hint::

        "Run sync once with internet to download embedding model"
    """
    base = rag_scheduler.get_status()
    base["next_scheduled_sync"] = rag_scheduler.next_scheduled_sync_iso()
    base["embedding_model_available"] = rag_embedder.is_model_available()
    base["chunks_total"] = rag_embedder.collection_size()
    base["superseded_docs"] = rag_embedder.superseded_docs_count()
    return base


@router.post("/sync")
async def rag_sync_trigger() -> dict[str, str]:
    """Kick off a sync in the background. Returns immediately."""
    # SECURITY: this endpoint is unauthenticated. It is safe only because
    # the backend binds to 127.0.0.1 (see main.py — uvicorn host). If the
    # bind address ever changes, add token auth here before shipping.
    # Fire-and-forget. The lock inside run_sync() guarantees we never
    # have two overlapping sync runs even if the user mashes the button.
    asyncio.create_task(rag_scheduler.run_sync())
    return {"status": "started", "message": "Sync started in background"}


@router.get("/documents")
def rag_documents() -> list[dict[str, Any]]:
    """List every indexed document with its chunk count and metadata."""
    return rag_embedder.list_documents()


@router.post("/reindex")
async def rag_reindex() -> dict[str, str]:
    """Wipe the chromadb collection and re-embed every local PDF on disk.

    Bypasses the scrape-time dedup set so every PDF — manual drop-folder
    or previously scraped — is re-embedded with the current metadata
    schema. Useful after improving supersession logic or after a vector
    store corruption. Returns immediately; progress is visible via
    ``GET /rag/status`` (``chunks_total`` will rise as the work completes).

    The reindex also clears the scrape dedup cache (``sync_status.json``
    plus the IK-fetched ``.txt`` files), so the next sync re-downloads
    every Indian Kanoon document fresh — no manual steps needed.
    """
    # SECURITY: this endpoint is unauthenticated and destructive (it wipes
    # the vector store). It is safe only because the backend binds to
    # 127.0.0.1 (see main.py — uvicorn host). If the bind address ever
    # changes, add token auth here before shipping.
    def _reindex_blocking() -> None:
        try:
            rag_embedder.clear_collection()
            # Clearing chromadb leaves sync_status.json's known_urls set
            # stale — the next sync would skip every already-fetched IK
            # document and add nothing. Drop the dedup cache so the next
            # sync re-fetches the IK corpus from scratch.
            rag_scheduler.clear_dedup_cache()
            rag_embedder.reembed_local_pdfs()
            rag_embedder.detect_supersessions()
        except Exception:
            # All helpers log internally; we swallow here so the
            # background task never explodes the event loop.
            pass

    asyncio.create_task(asyncio.to_thread(_reindex_blocking))
    return {"status": "started", "message": "Reindex started in background"}


@router.get("/docs-folder")
def rag_docs_folder() -> dict[str, Any]:
    """Return the absolute path to the manual-ingest docs folder.

    The frontend uses this to tell the user where to drop CBDT
    circulars / notifications / press releases / Acts as PDFs (or
    DOCX / TXT). On the next sync, the backend scans this folder
    and ingests any new files.
    """
    RAG_DOCS_DIR.mkdir(parents=True, exist_ok=True)
    return {
        "path": str(RAG_DOCS_DIR),
        "exists": RAG_DOCS_DIR.is_dir(),
    }
