"""``POST /generate`` — draft a legal reply via Ollama and persist it as DOCX.

The heart of the service. Takes extracted notice text + a free-form user
instruction + (optionally) prior conversation history, composes the chat
message array (system prompt + history + new user turn), runs it through
Ollama with model fallback, writes the reply to a timestamped ``.docx``
in ``backend/output/``, appends the turn to a session JSON in
``backend/data/``, and returns reply text + output path + session id.

Request body (JSON)::

    {
      "text":        "<extracted notice text from /upload>",   // optional if query is set
      "query":       "<user instruction>",                     // optional if text is set
      "model":       "qwen2.5:14b",                            // optional override
      "history":     [{"role": "user"|"assistant", "content": "..."}, ...],
      "session_id":  "<existing session id>",                  // null on first turn
      "temperature": 0.2                                        // 0.0–1.0
    }

Response::

    {
      "reply":       "<full DOCX-ready text of the legal reply>",
      "model_used":  "qwen2.5:14b" | "deepseek-r1:14b" | "<override>",
      "output_file": "<abs path to ITax_Reply_<ts>.docx>",
      "session_id":  "<id to pass back on the next turn>"
    }

HTTP errors:

* ``400`` — neither ``text`` nor ``query`` supplied
* ``503`` — Ollama unreachable, or all candidate models failed
* ``500`` — DOCX write or session-store failure

Model fallback chain (handled in :mod:`services.ollama_client`):
``model`` (if given) → ``qwen2.5:14b`` → ``deepseek-r1:14b``. The first
candidate that is locally pulled AND returns a non-empty response wins.
"""

import logging
import re
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from services.docx_writer import save_reply_docx
from services.ollama_client import OllamaUnavailable, chat
from services.prompts import build_messages
from services.session_store import append_turn

router = APIRouter()
log = logging.getLogger("itax.generate")

#: session_id is interpolated into a JSON filename by services.session_store.
#: Constrain it to a safe character set so a traversal payload cannot
#: escape backend/data/. Must mirror session_store._SESSION_ID_RE.
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


# ---------------------------------------------------------------------------
# Phase 2 RAG context injection helpers.
#
# Per spec:
#   * Embed the user's query+notice text, retrieve top-5 chunks from
#     chromadb (filtered to last 3 years), format as a context block,
#     and PREPEND that block to the existing system message produced
#     by services.prompts.build_messages.
#   * services/prompts.py is NOT modified — the augmentation happens
#     here, on the messages array, between build_messages() and chat().
#   * If RAG store is empty, embedding model is unavailable, or the
#     query call fails for any reason, fall back silently to the
#     un-augmented messages so generation never breaks.
# ---------------------------------------------------------------------------

_RAG_INSTRUCTION = (
    "\n\nUse the RELEVANT CBDT DOCUMENTS above as your primary source for "
    "citations. Only cite documents present in this context block. Do not "
    "fabricate circular numbers not present above."
)


def _format_rag_context(chunks: list[dict[str, Any]]) -> str:
    """Render retrieved chunks as the spec'd context block.

    Empty / missing fields collapse to a sensible label so the model
    always sees a usable header on each entry.
    """
    if not chunks:
        return ""
    lines: list[str] = ["--- RELEVANT CBDT DOCUMENTS ---"]
    for i, c in enumerate(chunks, start=1):
        ref = (c.get("cbdt_ref") or c.get("document_title") or "Document").strip()
        page = c.get("page_number") or 0
        page_part = f" (page {page})" if page else ""
        text = (c.get("text") or "").strip()
        if not text:
            continue
        lines.append(f"[{i}] {ref}{page_part}:")
        lines.append(f"    {text}")
    lines.append("--- END CBDT DOCUMENTS ---")
    return "\n".join(lines)


def _augment_messages_with_rag(
    messages: list[dict[str, Any]], notice_text: str, query: str
) -> list[dict[str, Any]]:
    """Prepend a RAG context block to the system message.

    Never raises — any failure (model not loaded, empty store, chromadb
    error) is logged at INFO and the original messages are returned
    unchanged.
    """
    try:
        # Local import keeps the heavy chromadb+sentence-transformers
        # stack out of cold-path import chains.
        from services import rag_embedder
    except ImportError:
        return messages

    query_for_retrieval = " ".join(part for part in (query, notice_text) if part).strip()
    if not query_for_retrieval:
        return messages

    try:
        chunks = rag_embedder.query(query_for_retrieval, n_results=5)
    except Exception as e:
        log.info("RAG query failed (%s); falling back to plain prompt", e)
        return messages
    if not chunks:
        return messages

    context_block = _format_rag_context(chunks)
    if not context_block:
        return messages

    augmented = [dict(m) for m in messages]
    if augmented and augmented[0].get("role") == "system":
        augmented[0]["content"] = (
            f"{context_block}{_RAG_INSTRUCTION}\n\n{augmented[0].get('content', '')}"
        )
    else:
        augmented.insert(
            0, {"role": "system", "content": f"{context_block}{_RAG_INSTRUCTION}"}
        )
    log.info("RAG: injected %d chunk(s) into system message", len(chunks))
    return augmented


class HistoryTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class GenerateRequest(BaseModel):
    text: str = Field("", description="Extracted notice/document text from /upload")
    query: str = Field("", description="User instruction (e.g., 'draft a reply citing Notification 35/2023').")
    model: str | None = Field(None, description="Optional Ollama model override")
    history: list[HistoryTurn] | None = Field(default=None, description="Prior turns of this session")
    session_id: str | None = Field(default=None, description="Existing session id to append to")
    temperature: float = Field(0.2, ge=0.0, le=1.0)

    @field_validator("session_id")
    @classmethod
    def _check_session_id(cls, v: str | None) -> str | None:
        """Reject a session_id that could escape backend/data/.

        ``None`` / ``""`` are allowed — both mean "start a new session";
        session_store then mints a fresh 12-hex id.
        """
        if v in (None, ""):
            return v
        if not _SESSION_ID_RE.fullmatch(v):
            raise ValueError("session_id must be 1-64 characters of [A-Za-z0-9_-]")
        return v
    save_output: bool = Field(
        False,
        description="When True, persist the reply as a .docx in backend/output/ and return its path. Defaults to False — callers that only need the text body can skip the disk write entirely.",
    )


class GenerateResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    reply: str
    model_used: str
    output_file: str | None = None
    session_id: str


@router.post("/generate", response_model=GenerateResponse)
def generate_reply(req: GenerateRequest):
    """Draft, persist, and return a legal reply for the supplied notice."""
    if not req.text.strip() and not req.query.strip():
        raise HTTPException(
            status_code=400,
            detail="Either 'text' (extracted notice) or 'query' (instruction) is required.",
        )

    messages = build_messages(
        notice_text=req.text,
        query=req.query,
        history=[h.model_dump() for h in (req.history or [])],
    )
    # Phase 2 — RAG augmentation. Silent fallback if the store is empty
    # or anything goes wrong; never break /generate.
    messages = _augment_messages_with_rag(
        messages, notice_text=req.text, query=req.query
    )

    try:
        reply, model_used = chat(
            messages=messages,
            model=req.model,
            temperature=req.temperature,
        )
    except OllamaUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")

    out_path = save_reply_docx(reply) if req.save_output else None

    sid = append_turn(
        session_id=req.session_id,
        notice_text=req.text,
        query=req.query,
        reply=reply,
        model=model_used,
        output_file=str(out_path) if out_path else "",
    )

    return GenerateResponse(
        reply=reply,
        model_used=model_used,
        output_file=str(out_path) if out_path else None,
        session_id=sid,
    )
