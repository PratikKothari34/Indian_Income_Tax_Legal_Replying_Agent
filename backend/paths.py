"""Runtime path + config resolution for the bundled backend.

In a packaged Windows install we cannot write to the install directory
(``C:\\Program Files\\ITaxReplyAgent\\``) because of UAC and per-user
expectations. All user data therefore lives under
``%LOCALAPPDATA%\\ITaxReplyAgent`` — works for domain accounts and
non-``C:`` user-profile installs.

This module is the single source of truth for those paths and for
``config.json``. Everything else in the backend imports from here.
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import os
import sys
from pathlib import Path
from typing import Any


def _is_frozen() -> bool:
    """True when running from a PyInstaller bundle (packaged install).

    PyInstaller sets ``sys.frozen`` to ``True`` and exposes the unpacked
    bundle root as ``sys._MEIPASS``. Either is a sufficient signal.
    """
    return bool(getattr(sys, "frozen", False)) or bool(getattr(sys, "_MEIPASS", None))


def _resolve_base_dir() -> Path:
    """Pick the on-disk root for runtime data.

    * **Packaged (frozen)** → ``%LOCALAPPDATA%\\ITaxReplyAgent`` — the
      install dir under ``Program Files`` is read-only for normal users.
    * **Dev (running from source)** → the ``backend/`` folder itself, so
      ``backend/data``, ``backend/output``, ``backend/rag`` etc. live
      next to the source. This matches what ``frontend/electron/main.ts``
      uses for its dev IPC paths, so the Python backend and the Electron
      main process see the same on-disk layout in dev.
    """
    if _is_frozen():
        appdata = os.environ.get("LOCALAPPDATA") or os.path.join(
            os.path.expanduser("~"), "AppData", "Local"
        )
        return Path(appdata) / "ITaxReplyAgent"
    # Dev: backend/ is this file's directory.
    return Path(__file__).resolve().parent


BASE_DIR: Path = _resolve_base_dir()
DATA_DIR: Path = BASE_DIR / "data"
OUTPUT_DIR: Path = BASE_DIR / "output"
UPLOADS_DIR: Path = BASE_DIR / "uploads"
LOGS_DIR: Path = BASE_DIR / "logs"
CONFIG_PATH: Path = BASE_DIR / "config.json"
PORT_FILE: Path = BASE_DIR / "port.txt"

# Phase 2 — RAG layout. All vector-store + downloaded-PDF state lives under
# BASE_DIR/rag so the entire app remains a single uninstall target.
RAG_DIR: Path = BASE_DIR / "rag"
RAG_DOCS_DIR: Path = RAG_DIR / "docs"
RAG_CHROMADB_DIR: Path = RAG_DIR / "chromadb"
RAG_MODELS_DIR: Path = RAG_DIR / "models"
RAG_SYNC_STATUS: Path = RAG_DIR / "sync_status.json"
RAG_LOG_FILE: Path = LOGS_DIR / "rag.log"

DEFAULT_CONFIG: dict[str, Any] = {
    "ollama_host": "127.0.0.1",
    "ollama_port": 11434,
    "backend_port": 8000,
    "model_storage_path": os.path.join(os.path.expanduser("~"), ".ollama", "models"),
    # Cron schedule for the RAG sync job (APScheduler crontab format).
    # Default: daily at 02:00 local time.
    "rag_sync_schedule": "0 12 * * *",
    # Indian Kanoon API token. Used by services/rag_scraper.py to auto-fetch
    # CBDT circulars, notifications, Finance Acts, and the Income Tax Act /
    # Rules from https://api.indiankanoon.org/. Empty string disables the
    # auto-scrape path (manual drop-folder ingest still works).
    #
    # SECURITY: This field is intentionally blank in source. The real token
    # must be written into config.json at runtime (AppData on a packaged
    # install, backend/ in dev) via one of:
    #   * the NSIS installer config page (planned),
    #   * the in-app Settings panel (planned),
    #   * a hand edit by the developer for local testing.
    # Never commit a populated token here — config.json is per-install state,
    # not source.
    "indiankanoon_token": "",
    # Enable the incometaxindia.gov.in /news/*.pdf direct-PDF scraper.
    # See services/rag_scraper.py::scrape_incometax_pdfs. Setting this to
    # False disables Phase B of the sync without removing the code (useful
    # if the source starts returning 403 from your network).
    "incometax_pdf_scraper_enabled": True,
    "run_at_startup": False,
    "system_tray": True,
    "keep_awake": True,
}

#: Ports the backend will try in order if the configured port is already bound.
PORT_FALLBACK_CHAIN: tuple[int, ...] = (8000, 8001, 8002, 8003)


def ensure_dirs() -> None:
    """Create every runtime directory if missing. Safe to call repeatedly."""
    for d in (
        BASE_DIR,
        DATA_DIR,
        OUTPUT_DIR,
        UPLOADS_DIR,
        LOGS_DIR,
        RAG_DIR,
        RAG_DOCS_DIR,
        RAG_CHROMADB_DIR,
        RAG_MODELS_DIR,
    ):
        d.mkdir(parents=True, exist_ok=True)


# Eager directory creation at module import — before any other module
# imports a path constant (e.g. session_store imports DATA_DIR, embedder
# imports RAG_CHROMADB_DIR). Anything that subsequently touches one of
# these constants is guaranteed to find the directory already on disk.
ensure_dirs()


def configure_hf_cache() -> None:
    """Pin the Hugging Face cache to ``RAG_MODELS_DIR``.

    Sets ``HF_HOME`` (and the older ``TRANSFORMERS_CACHE`` / ``SENTENCE_TRANSFORMERS_HOME``
    aliases) before any sentence-transformers import. Without this, the
    library writes to ``%USERPROFILE%\\.cache\\huggingface`` which (a)
    is invisible to the uninstaller and (b) causes a re-download on
    first run for every Windows user account.
    """
    ensure_dirs()
    rag_models = str(RAG_MODELS_DIR)
    os.environ.setdefault("HF_HOME", rag_models)
    os.environ.setdefault("TRANSFORMERS_CACHE", rag_models)
    os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", rag_models)
    # Disable the HF telemetry pings — strict local-only.
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


def load_config() -> dict[str, Any]:
    """Read ``config.json`` from ``BASE_DIR``.

    If missing or corrupt, recreate with defaults and log the event. The
    returned dict is always populated with every key in :data:`DEFAULT_CONFIG`
    (missing keys are filled in from defaults but the file is preserved).
    """
    ensure_dirs()
    if not CONFIG_PATH.exists():
        save_config(DEFAULT_CONFIG)
        logging.getLogger(__name__).info("config.json missing — wrote defaults")
        return dict(DEFAULT_CONFIG)
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as f:
            cfg = json.load(f)
        if not isinstance(cfg, dict):
            raise ValueError("config.json is not a JSON object")
    except (json.JSONDecodeError, OSError, ValueError) as e:
        logging.getLogger(__name__).warning(
            "config.json corrupt (%s) — recreating with defaults", e
        )
        save_config(DEFAULT_CONFIG)
        return dict(DEFAULT_CONFIG)
    merged = dict(DEFAULT_CONFIG)
    merged.update({k: v for k, v in cfg.items() if k in DEFAULT_CONFIG})
    return merged


def save_config(cfg: dict[str, Any]) -> None:
    """Write ``cfg`` to ``config.json`` atomically (write-temp-then-rename)."""
    ensure_dirs()
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    os.replace(tmp, CONFIG_PATH)


def write_port(port: int) -> None:
    """Write the actually-bound backend port to ``port.txt`` for the frontend."""
    ensure_dirs()
    PORT_FILE.write_text(str(port), encoding="utf-8")


def configure_tesseract() -> None:
    """If running from a PyInstaller bundle, point pytesseract at the
    bundled ``tesseract.exe`` (placed by ``--add-binary`` next to the
    extracted bundle root, ``sys._MEIPASS``).

    No-op outside a frozen bundle: developers run with the system-installed
    Tesseract on ``PATH``.
    """
    meipass = getattr(sys, "_MEIPASS", None)
    if not meipass:
        return
    bundled_exe = Path(meipass) / "tesseract.exe"
    if not bundled_exe.exists():
        return
    try:
        import pytesseract

        pytesseract.pytesseract.tesseract_cmd = str(bundled_exe)
        os.environ["TESSDATA_PREFIX"] = str(Path(meipass) / "tessdata")
    except ImportError:
        # If pytesseract isn't installed for some reason, image OCR is
        # simply unavailable — no need to crash the whole backend.
        pass


def configure_logging() -> None:
    """Send root-logger output to ``logs/backend.log`` with size-based rotation.

    Max 5 MB per file, keep last 3 files. stderr is also kept so that when
    the backend is run directly (not via the Electron spawner) the user
    still sees logs in the console.
    """
    ensure_dirs()
    log_file = LOGS_DIR / "backend.log"
    handler = logging.handlers.RotatingFileHandler(
        log_file, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    handler.setFormatter(fmt)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    # Avoid double-attaching on reload (e.g., uvicorn reload mode).
    if not any(isinstance(h, logging.handlers.RotatingFileHandler) for h in root.handlers):
        root.addHandler(handler)

    # Also keep a stderr handler in dev / direct-launch mode.
    if not any(isinstance(h, logging.StreamHandler) and not isinstance(
        h, logging.handlers.RotatingFileHandler
    ) for h in root.handlers):
        stream = logging.StreamHandler(sys.stderr)
        stream.setFormatter(fmt)
        root.addHandler(stream)

    # Tame uvicorn / fastapi verbosity to INFO.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "fastapi"):
        logging.getLogger(name).setLevel(logging.INFO)

    # Resolved-path banner — first line in backend.log on every boot.
    # If a future RAG sync seems to "write nowhere", these are the
    # paths it actually wrote to.
    mode = "frozen-bundle" if _is_frozen() else "dev (source tree)"
    logging.getLogger("itax.paths").info(
        "runtime mode = %s | BASE_DIR = %s", mode, BASE_DIR
    )
    logging.getLogger("itax.paths").info(
        "  DATA_DIR=%s OUTPUT_DIR=%s UPLOADS_DIR=%s LOGS_DIR=%s",
        DATA_DIR,
        OUTPUT_DIR,
        UPLOADS_DIR,
        LOGS_DIR,
    )
    logging.getLogger("itax.paths").info(
        "  RAG_DIR=%s RAG_DOCS_DIR=%s RAG_CHROMADB_DIR=%s",
        RAG_DIR,
        RAG_DOCS_DIR,
        RAG_CHROMADB_DIR,
    )
    logging.getLogger("itax.paths").info(
        "  RAG_SYNC_STATUS=%s RAG_LOG_FILE=%s",
        RAG_SYNC_STATUS,
        RAG_LOG_FILE,
    )


def get_rag_logger() -> logging.Logger:
    """Return a logger that writes to ``logs/rag.log`` (rotating, 5 MB × 3).

    Separate from ``backend.log`` so RAG sync activity (which can be
    chatty: per-PDF download + embed lines) does not drown the server
    log. Idempotent — repeated calls return the same logger without
    re-attaching handlers.
    """
    ensure_dirs()
    logger = logging.getLogger("itax.rag")
    logger.setLevel(logging.INFO)
    # Avoid double-attach on repeated calls.
    for h in logger.handlers:
        if isinstance(h, logging.handlers.RotatingFileHandler):
            return logger
    handler = logging.handlers.RotatingFileHandler(
        RAG_LOG_FILE, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s [%(levelname)s] %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    )
    logger.addHandler(handler)
    # Don't bubble RAG chatter up to the root backend.log.
    logger.propagate = False
    return logger
