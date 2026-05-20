"""FastAPI entrypoint for the Indian Income Tax Legal Replying Agent.

In a packaged Windows install, all user data lives under
``%LOCALAPPDATA%\\ITaxReplyAgent`` (see :mod:`paths`). The server binds to
``127.0.0.1`` only and falls through 8000 → 8001 → 8002 → 8003 if the
configured port is already in use, writing the actually-bound port to
``BASE_DIR\\port.txt`` so the Electron frontend can pick it up. There are
no outbound network calls except to the local Ollama daemon.

Run with::

    python main.py
    # or, identically:
    python -m uvicorn main:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import logging
import socket

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from paths import (
    PORT_FALLBACK_CHAIN,
    configure_hf_cache,
    configure_logging,
    configure_tesseract,
    ensure_dirs,
    load_config,
    write_port,
)
from routes import generate, health, models, rag, upload
from services import rag_scheduler

ensure_dirs()
configure_logging()
configure_tesseract()
# Pin Hugging Face cache to AppData\rag\models BEFORE any
# sentence-transformers import — the embedder loads lazily, but
# setting the env var early is what guarantees no surprise download
# into %USERPROFILE%\.cache\huggingface.
configure_hf_cache()
log = logging.getLogger("itax.backend")

app = FastAPI(
    title="Indian Income Tax Legal Replying Agent",
    description="Local-only backend for drafting legal replies to Income Tax notices.",
    version="1.0.0",
)

# Electron dev origins + packaged file:// origin (which sends Origin: null).
allowed_origins = [
    "http://localhost",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8000",
    "http://localhost:8001",
    "http://localhost:8002",
    "http://localhost:8003",
    "http://127.0.0.1",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8000",
    "http://127.0.0.1:8001",
    "http://127.0.0.1:8002",
    "http://127.0.0.1:8003",
    "null",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Request-body cap for POST /generate. An OCR'd legal notice can be sizeable,
# but 10 MiB is a generous ceiling; anything past it is rejected before the
# JSON body is parsed. Content-Length is the gate — Electron and httpx both
# send it for a JSON POST. A chunked request with no Content-Length is not
# capped here (acceptable: the backend binds to 127.0.0.1 only).
MAX_GENERATE_BODY_BYTES = 10 * 1024 * 1024  # 10 MiB


@app.middleware("http")
async def limit_generate_body(request, call_next):
    """Reject an oversized POST /generate body with HTTP 413.

    Two gates: the Content-Length header (cheap, the normal case) and —
    for a chunked request that carries no Content-Length — a materialised
    read of the body. Starlette caches the body it reads here, so the
    downstream route still parses it normally.
    """
    if request.method == "POST" and request.url.path == "/generate":
        limit_mib = MAX_GENERATE_BODY_BYTES // (1024 * 1024)
        too_large = JSONResponse(
            status_code=413,
            content={"detail": f"Request body exceeds the {limit_mib} MiB limit."},
        )
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                declared = int(content_length)
            except ValueError:
                declared = -1
            if declared > MAX_GENERATE_BODY_BYTES:
                return too_large
        elif request.headers.get("transfer-encoding", "").lower() == "chunked":
            # No Content-Length to trust — a chunked request would slip the
            # header check. Materialise the body and measure it; Starlette
            # caches it so call_next() can still read it downstream.
            body = await request.body()
            if len(body) > MAX_GENERATE_BODY_BYTES:
                return too_large
    return await call_next(request)


app.include_router(health.router)
app.include_router(models.router)
app.include_router(upload.router)
app.include_router(generate.router)
app.include_router(rag.router)

# Phase 2 — RAG scheduler. Attaches APScheduler to FastAPI startup /
# shutdown events and runs an initial sync if the store is empty or
# the last sync is older than 24 h.
rag_scheduler.init_scheduler(app)


@app.get("/")
def root():
    """Discovery endpoint. Lists the available top-level routes."""
    return {
        "name": "Indian Income Tax Legal Replying Agent",
        "status": "running",
        "endpoints": ["/health", "/models", "/upload", "/generate"],
    }


def _port_in_use(host: str, port: int) -> bool:
    """True if ``host:port`` is already bound by another process."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        try:
            sock.bind((host, port))
        except OSError:
            return True
    return False


def _resolve_port(preferred: int) -> int:
    """Pick the first free port: preferred, then the fallback chain."""
    candidates: list[int] = [preferred]
    for p in PORT_FALLBACK_CHAIN:
        if p not in candidates:
            candidates.append(p)
    for p in candidates:
        if not _port_in_use("127.0.0.1", p):
            return p
    raise RuntimeError(
        f"All candidate backend ports are in use: {candidates}"
    )


def run() -> None:
    """Start uvicorn on the configured port (with fallback)."""
    import uvicorn

    cfg = load_config()
    preferred = int(cfg.get("backend_port", 8000))
    port = _resolve_port(preferred)

    if port != preferred:
        log.warning(
            "Preferred backend port %d is in use; falling back to %d", preferred, port
        )
        cfg["backend_port"] = port
        from paths import save_config

        save_config(cfg)

    write_port(port)
    log.info("Backend starting on http://127.0.0.1:%d (port.txt updated)", port)

    # Bind to 127.0.0.1 only — strictly local. log_config=None so our root
    # handlers (rotating file + stderr) own all output.
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=port,
        reload=False,
        log_config=None,
    )


if __name__ == "__main__":
    run()
