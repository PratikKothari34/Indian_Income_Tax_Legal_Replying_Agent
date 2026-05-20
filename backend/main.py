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
