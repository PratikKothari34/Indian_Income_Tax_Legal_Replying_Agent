"""FastAPI entrypoint for the Indian Income Tax Legal Replying Agent.

In a packaged Windows install, all user data lives under
``%LOCALAPPDATA%\\ITaxReplyAgent`` (see :mod:`paths`). The server binds to
``127.0.0.1`` only and falls through 8000 → 8001 → 8002 → 8003 if the
configured port is already in use, writing the actually-bound port to
``BASE_DIR\\port.txt`` so the Electron frontend can pick it up. The only
outbound network calls are to the configured Ollama daemon and — during a
RAG sync — the Indian Kanoon API / incometaxindia.gov.in scrapers.

Run with::

    python main.py
    # or, identically:
    python -m uvicorn main:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import logging
import secrets
import socket

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from paths import (
    PORT_FALLBACK_CHAIN,
    configure_hf_cache,
    configure_logging,
    configure_tesseract,
    ensure_auth_token,
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
    # No cookies or HTTP auth are used anywhere — keep credentials off so
    # the "null" origin (packaged Electron, but also any sandboxed iframe)
    # can never be combined with ambient credentials.
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Local-origin guard.
#
# Binding to 127.0.0.1 keeps remote hosts out, but any web page the user
# visits can still fire cross-origin "simple" POSTs at localhost (classic
# drive-by CSRF — no preflight for form/text bodies), and DNS rebinding can
# put a hostile hostname in front of this port. Two gates close that:
#
#   1. The Host header must be 127.0.0.1 / localhost (kills DNS rebinding).
#   2. A mutating request carrying a browser Origin must either come from
#      one of our own dev origins, or present the per-install auth token
#      (X-ITax-Auth). The packaged Electron renderer runs on the file://
#      "null" origin and reads the token from AppData via IPC; a hostile
#      page — including a sandboxed null-origin iframe — cannot read it.
#
# Requests with NO Origin header (curl, httpx, the smoke test) are untouched,
# so the documented HTTP API is unchanged for local tooling.
# ---------------------------------------------------------------------------
_LOCAL_API_TOKEN = ensure_auth_token()
_ALLOWED_HOSTNAMES = frozenset({"127.0.0.1", "localhost"})
_TRUSTED_BROWSER_ORIGINS = frozenset(o for o in allowed_origins if o != "null")
_MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


@app.middleware("http")
async def local_origin_guard(request, call_next):
    """Reject DNS-rebinding hosts and unauthenticated cross-origin writes."""
    host = (request.headers.get("host") or "").split(":", 1)[0].lower()
    if host and host not in _ALLOWED_HOSTNAMES:
        return JSONResponse(status_code=403, content={"detail": "Forbidden host."})
    if request.method in _MUTATING_METHODS:
        origin = request.headers.get("origin")
        if origin is not None and origin not in _TRUSTED_BROWSER_ORIGINS:
            supplied = request.headers.get("x-itax-auth") or ""
            if not secrets.compare_digest(supplied, _LOCAL_API_TOKEN):
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Missing or invalid local auth token."},
                )
    return await call_next(request)

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
        "endpoints": ["/health", "/models", "/upload", "/generate", "/rag"],
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
    #
    # Pass the app OBJECT, not the "main:app" import string. The string form
    # makes uvicorn re-import a module named `main`, which does not exist
    # inside a PyInstaller bundle — there main.py is the __main__ script, not
    # an importable module on sys.path. That failed with "Error loading ASGI
    # app. Could not import module 'main'." and the packaged backend exited 1
    # before ever binding a port. Running from source worked either way, so
    # this only ever reproduced in the frozen build.
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        reload=False,
        log_config=None,
    )


if __name__ == "__main__":
    run()
