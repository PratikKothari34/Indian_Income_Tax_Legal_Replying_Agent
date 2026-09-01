"""APScheduler glue: scrape → embed → status, on a cron + on demand.

Phase 2 RAG. Wires the scraper and embedder behind a single
``run_sync`` coroutine and schedules it via APScheduler attached to
the FastAPI app lifecycle.

Design notes:

* :class:`AsyncIOScheduler` is used so we share the FastAPI event loop
  rather than spawning a worker thread.
* The job uses a single :class:`asyncio.Lock` to guarantee no two syncs
  ever overlap — scheduled and manual triggers funnel through the same
  ``_sync_lock``.
* The actual scraper + embedder calls are blocking I/O / CPU work; we
  run them via :func:`asyncio.to_thread` so a 5-minute embed pass does
  not stall the FastAPI event loop.
* All status is persisted to ``sync_status.json`` so it survives a
  process restart and can be read by ``GET /rag/status`` without going
  through any in-memory state.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from paths import (
    RAG_DOCS_DIR,
    RAG_SYNC_STATUS,
    _replace_with_retry,
    ensure_dirs,
    get_rag_logger,
    load_config,
)

log = get_rag_logger()

# Single global lock so scheduled + manual triggers are mutually exclusive.
_sync_lock: asyncio.Lock | None = None
_scheduler: Any = None  # AsyncIOScheduler instance (typed loosely to avoid import at module load)
_default_cron_expr = "0 12 * * *"  # daily at 12:00 (noon) local time


# ---------------------------------------------------------------------------
# sync_status.json read/write
# ---------------------------------------------------------------------------
def _read_status_raw() -> dict[str, Any]:
    """Read sync_status.json. Returns {} on missing/corrupt."""
    if not RAG_SYNC_STATUS.exists():
        return {}
    try:
        with RAG_SYNC_STATUS.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _write_status(updates: dict[str, Any]) -> None:
    """Merge ``updates`` into sync_status.json (atomic temp-then-rename).

    Preserves untouched keys (notably ``known_urls`` written by the
    scraper) so this function is safe to call between scrapes.
    """
    ensure_dirs()
    payload = _read_status_raw()
    payload.update(updates)
    # Unique temp name + retrying replace, matching paths.save_config. The
    # scraper writes this same file (known_urls) and a reindex can delete
    # it while a sync is finishing, so the swap must tolerate a transient
    # Windows sharing violation instead of crashing the sync.
    tmp = RAG_SYNC_STATUS.with_suffix(f".json.{os.getpid()}-{uuid.uuid4().hex[:8]}.tmp")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
        _replace_with_retry(tmp, RAG_SYNC_STATUS)
    except OSError as e:
        log.warning("could not write sync_status.json: %s", e)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def get_status() -> dict[str, Any]:
    """Public read of the persisted sync status.

    The shape returned here is what ``GET /rag/status`` will return,
    minus the ``next_scheduled_sync`` field (computed in the route from
    the live scheduler).
    """
    raw = _read_status_raw()
    return {
        "last_sync": raw.get("last_sync"),
        "docs_total": int(raw.get("docs_total") or 0),
        "docs_added_last_run": int(raw.get("docs_added_last_run") or 0),
        "last_sync_status": raw.get("last_sync_status") or "never",
        "errors": list(raw.get("errors") or []),
    }


def clear_dedup_cache() -> dict[str, Any]:
    """Wipe the scrape dedup state so the next sync re-fetches everything.

    Called by ``POST /rag/reindex``. ``sync_status.json`` holds the
    ``known_urls`` set the scraper uses to skip already-downloaded Indian
    Kanoon documents; after a reindex that set is stale and would make the
    next sync fetch nothing. To force a clean re-fetch we:

    * delete ``sync_status.json`` entirely — ``known_urls`` resets to empty;
    * delete every IK-fetched ``.txt`` file under ``RAG_DOCS_DIR`` (and its
      subfolders) so the scraper re-downloads them. ``.pdf`` files — added
      manually by the user — are left in place.

    Returns ``{"status_cleared": bool, "txt_removed": int}``. Never raises:
    a filesystem error is logged and reflected in the returned counts.
    """
    status_cleared = False
    try:
        if RAG_SYNC_STATUS.exists():
            RAG_SYNC_STATUS.unlink()
            status_cleared = True
            log.info("[reindex] cleared sync_status.json — known_urls reset")
    except OSError as e:
        log.warning("[reindex] could not delete sync_status.json: %s", e)

    txt_removed = 0
    try:
        for txt in RAG_DOCS_DIR.rglob("*.txt"):
            try:
                txt.unlink()
                txt_removed += 1
            except OSError as e:
                log.warning("[reindex] could not delete %s: %s", txt.name, e)
    except OSError as e:
        log.warning("[reindex] could not scan %s for .txt files: %s", RAG_DOCS_DIR, e)
    log.info(
        "[reindex] removed %d IK text files — will re-fetch on next sync", txt_removed
    )

    return {"status_cleared": status_cleared, "txt_removed": txt_removed}


# ---------------------------------------------------------------------------
# The pipeline itself
# ---------------------------------------------------------------------------
def _run_sync_blocking() -> dict[str, Any]:
    """Synchronous body of one sync cycle. Runs in a worker thread.

    Returns the dict that will be merged into sync_status.json.
    """
    # Imports are local because chromadb + sentence-transformers are
    # heavy and we don't want to pay the startup cost on every backend
    # boot — only when a sync actually runs.
    from services import rag_embedder, rag_scraper

    started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    errors: list[str] = []
    status = "success"

    # ----- Phase 1 — scrape ------------------------------------------------
    try:
        scrape_result = rag_scraper.scrape_all_sources()
    except Exception as e:
        log.exception("scrape phase crashed")
        return {
            "last_sync": started_at,
            "last_sync_status": "failed",
            "docs_added_last_run": 0,
            "errors": [f"scrape crashed: {e}"],
        }
    if scrape_result["sources_bad"]:
        status = "partial"
    errors.extend(scrape_result.get("errors") or [])

    # ----- Phase 2 — embed -------------------------------------------------
    chunks_added = 0
    try:
        chunks_added = rag_embedder.ingest_many(scrape_result["downloaded"])
    except Exception as e:
        log.exception("embed phase crashed")
        errors.append(f"embed crashed: {e}")
        status = "partial" if status == "success" else status

    # ----- Phase 2b — supersession detection ------------------------------
    try:
        marked = rag_embedder.detect_supersessions()
        if marked:
            log.info("supersession pass marked %d chunk(s)", marked)
    except Exception as e:
        log.exception("supersession pass crashed")
        errors.append(f"supersession crashed: {e}")
        status = "partial" if status == "success" else status

    # ----- Phase 3 — totals ------------------------------------------------
    try:
        docs_total = len(rag_embedder.list_documents())
    except Exception as e:
        docs_total = 0
        errors.append(f"list_documents crashed: {e}")

    finished_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    log.info(
        "sync done — added=%d total=%d status=%s errors=%d",
        len(scrape_result["downloaded"]),
        docs_total,
        status,
        len(errors),
    )

    return {
        "last_sync": finished_at,
        "last_sync_started": started_at,
        "last_sync_status": status,
        "docs_added_last_run": len(scrape_result["downloaded"]),
        "chunks_added_last_run": chunks_added,
        "docs_total": docs_total,
        "errors": errors[:50],  # cap to keep status file small
    }


async def run_sync() -> dict[str, Any]:
    """Run one sync cycle. Lock-protected, idempotent under concurrency.

    Schedules the heavy work onto a worker thread via
    ``asyncio.to_thread`` so the event loop stays responsive. Manual
    triggers (``POST /rag/sync``) and the cron job both go through this
    function.
    """
    global _sync_lock
    if _sync_lock is None:
        _sync_lock = asyncio.Lock()

    # Skip rather than queue: POST /rag/sync is fire-and-forget, so a second
    # caller that waited on the lock would fire a duplicate scrape the moment
    # the first finished.
    #
    # The check and the acquire below are atomic despite being two statements:
    # asyncio is single-threaded, and acquiring an uncontended lock completes
    # without yielding to the event loop, so no other coroutine can interleave
    # between them.
    if _sync_lock.locked():
        log.info("run_sync: skipped — another sync is already in progress")
        return {"skipped": True, "reason": "already running"}

    async with _sync_lock:
        result = await asyncio.to_thread(_run_sync_blocking)
        _write_status(result)
        return result


# ---------------------------------------------------------------------------
# Scheduler wiring
# ---------------------------------------------------------------------------
def _parse_cron(expr: str | None) -> tuple[str, str, str, str, str]:
    """Parse a 5-field cron string ``"m h dom mon dow"`` for APScheduler.

    Field *count* is not enough on its own: ``"99 99 99 99 99"`` has five
    fields but every one is out of range, and APScheduler only discovers
    that when :class:`CronTrigger` is constructed. Since ``init_scheduler``
    runs at import time in ``main.py``, an unbuildable expression there
    took the whole backend down at startup rather than just disabling the
    sync. ``rag_sync_schedule`` is user-editable from the Settings panel,
    so that was reachable without touching a config file by hand.

    We therefore build a throwaway trigger here and fall back to the
    default on any rejection, guaranteeing the value we return is one
    APScheduler will accept.
    """
    fields = (expr or _default_cron_expr).split()
    if len(fields) != 5:
        log.warning(
            "cron %r does not have 5 fields — using default %r",
            expr,
            _default_cron_expr,
        )
        fields = _default_cron_expr.split()
    elif not _cron_fields_valid(fields):
        log.warning(
            "cron %r is not a valid schedule — using default %r",
            expr,
            _default_cron_expr,
        )
        fields = _default_cron_expr.split()
    return tuple(fields)  # type: ignore[return-value]


def _cron_fields_valid(fields: list[str]) -> bool:
    """True if APScheduler can build a CronTrigger from these five fields.

    Returns ``True`` when APScheduler is not installed — the caller logs
    that separately and disables the scheduler outright, so there is no
    schedule left to validate.
    """
    try:
        from apscheduler.triggers.cron import CronTrigger
    except ImportError:  # pragma: no cover
        return True
    try:
        CronTrigger(
            minute=fields[0],
            hour=fields[1],
            day=fields[2],
            month=fields[3],
            day_of_week=fields[4],
        )
        return True
    except (ValueError, TypeError):
        return False


def _should_run_now() -> bool:
    """True if the RAG store is empty OR last sync was > 24 h ago.

    Drives the boot-time "catch up if stale" trigger. Errors reading
    the status file fall through to ``True`` — a redundant sync on
    boot is cheaper than missing one entirely.
    """
    raw = _read_status_raw()
    last = raw.get("last_sync")
    if not last:
        return True
    try:
        last_dt = datetime.fromisoformat(last)
        if last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return True
    age = datetime.now(timezone.utc) - last_dt
    if age >= timedelta(hours=24):
        return True
    # Empty store also forces a run.
    try:
        from services import rag_embedder

        return rag_embedder.collection_size() == 0
    except Exception:
        return True


def init_scheduler(app: Any) -> None:
    """Attach an :class:`AsyncIOScheduler` to the FastAPI app.

    Adds a startup hook that:

    * Schedules the cron job (``rag_sync_schedule`` from ``config.json``,
      defaulting to ``"0 12 * * *"``).
    * Triggers an immediate sync if the store is empty or the last sync
      is older than 24 hours.

    Adds a shutdown hook that stops the scheduler cleanly.
    """
    try:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from apscheduler.triggers.cron import CronTrigger
    except ImportError:  # pragma: no cover
        log.error(
            "APScheduler is not installed — RAG cron disabled. "
            "Install with: pip install -r requirements.txt"
        )
        return

    cfg = load_config()
    minute, hour, day, month, dow = _parse_cron(str(cfg.get("rag_sync_schedule")))

    global _scheduler
    _scheduler = AsyncIOScheduler()
    # _parse_cron has already proven these fields build a trigger, so this
    # should not raise. Belt-and-braces: init_scheduler is called at import
    # time from main.py, and the RAG sync is a background convenience — it
    # must never be the reason the backend refuses to start.
    try:
        trigger = CronTrigger(
            minute=minute, hour=hour, day=day, month=month, day_of_week=dow
        )
    except (ValueError, TypeError):
        log.exception("could not build cron trigger — RAG sync disabled this boot")
        _scheduler = None
        return

    async def _job() -> None:
        try:
            await run_sync()
        except Exception:
            log.exception("scheduled sync raised")

    _scheduler.add_job(
        _job,
        trigger=trigger,
        id="rag_sync",
        name="Scheduled CBDT RAG sync",
        replace_existing=True,
        misfire_grace_time=3600,
        coalesce=True,
        max_instances=1,
    )

    @app.on_event("startup")
    async def _start() -> None:
        try:
            _scheduler.start()
            log.info(
                "scheduler started — cron=%s %s %s %s %s",
                minute,
                hour,
                day,
                month,
                dow,
            )
        except Exception:
            log.exception("scheduler.start() failed")
            return
        if _should_run_now():
            log.info("running initial sync (store empty or > 24 h since last)")
            asyncio.create_task(_job())

    @app.on_event("shutdown")
    async def _stop() -> None:
        try:
            _scheduler.shutdown(wait=False)
            log.info("scheduler stopped")
        except Exception:
            log.exception("scheduler.shutdown() failed")


def next_scheduled_sync_iso() -> str | None:
    """Best-effort ISO timestamp of the next scheduled sync run."""
    if _scheduler is None:
        return None
    try:
        job = _scheduler.get_job("rag_sync")
        if job is None or job.next_run_time is None:
            return None
        return job.next_run_time.isoformat(timespec="seconds")
    except Exception:
        return None
