"""Per-session conversation store backed by JSON files on disk.

Each session is one file: ``backend/data/session_<id>.json``. A session
file looks like::

    {
      "session_id": "<12-hex>",
      "created_at": "2026-05-03T16:10:46",
      "updated_at": "2026-05-03T16:26:35",
      "turns": [
        {
          "timestamp":   "2026-05-03T16:10:46",
          "model":       "qwen2.5:14b",
          "notice_text": "<extracted notice text>",
          "query":       "<user instruction>",
          "reply":       "<full DOCX-ready legal reply>",
          "output_file": "<abs path to ITax_Reply_<ts>.docx>"
        },
        ...
      ]
    }

Sessions are append-only — :func:`append_turn` either creates a new
session file (when ``session_id`` is ``None``) or appends one turn to an
existing file. There is intentionally no compaction or pruning; the user
manages the ``data/`` directory directly.

Why JSON-on-disk and not a database?

* Strictly local deployment, single user, low write rate — anything more
  than JSON would be over-engineered.
* Trivial to back up, audit, or re-import into the Electron frontend.
* Survives crashes — every turn is fsync'd before the response returns.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import uuid
from datetime import datetime
from pathlib import Path

from paths import DATA_DIR

log = logging.getLogger("itax.sessions")

#: Serialises the read-modify-write in :func:`append_turn`.
#:
#: ``POST /generate`` is a sync FastAPI endpoint, so Starlette runs it in a
#: worker thread and two requests genuinely execute in parallel. Generation
#: takes minutes, which makes overlap easy to hit — a second window, or a
#: script driving the documented HTTP API. Without this lock, concurrent
#: appends to one session raced three ways: turns were silently lost
#: (both writers started from the same snapshot), ``os.replace`` failed
#: with ``PermissionError`` on Windows because another writer still held
#: the destination open, and a reader that caught a half-written file
#: quarantined a perfectly good session as "corrupt".
#:
#: One process-wide lock is enough because the backend runs as a single
#: uvicorn worker; the critical section is a small JSON dump, so contention
#: is not a concern. It does NOT protect against a second backend process
#: writing the same directory, which the app never starts.
_write_lock = threading.Lock()

#: A session id is either a generated 12-hex token or a caller-supplied
#: value continuing an existing conversation. It is interpolated straight
#: into a filename, so it must be constrained to a safe character set —
#: an unvalidated id such as "../../../config" would escape DATA_DIR and
#: let a client write a JSON file anywhere on disk.
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _path_for(session_id: str) -> Path:
    if not _SESSION_ID_RE.fullmatch(session_id):
        raise ValueError(f"Invalid session id: {session_id!r}")
    return DATA_DIR / f"session_{session_id}.json"


def _new_session(sid: str) -> dict:
    """A fresh, empty session document."""
    return {
        "session_id": sid,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "turns": [],
    }


def _load_or_new(path: Path, sid: str) -> dict:
    """Load an existing session file, or return a fresh one.

    A session file is user-visible state in ``backend/data/`` and can be
    hand-edited, truncated by a crash mid-write, or synced by OneDrive. Any
    of those leaves JSON that no longer matches the expected shape. Because
    :func:`append_turn` sits on the ``/generate`` request path, a malformed
    file previously surfaced as an HTTP 500 and the user lost the reply that
    had already been generated.

    Recovery is deliberate rather than silent: the unreadable file is moved
    aside to ``<name>.corrupt-<timestamp>`` so nothing is destroyed, and a
    fresh session takes its place. Three shapes are treated as unusable —
    invalid JSON, a top-level value that is not an object, and a ``turns``
    field that is missing or not a list.
    """
    if not path.exists():
        return _new_session(sid)

    try:
        with path.open("r", encoding="utf-8") as f:
            session = json.load(f)
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as e:
        log.warning("session %s unreadable (%s) — starting a fresh session", sid, e)
        _quarantine(path)
        return _new_session(sid)

    if not isinstance(session, dict) or not isinstance(session.get("turns"), list):
        log.warning(
            "session %s has an unexpected shape — starting a fresh session", sid
        )
        _quarantine(path)
        return _new_session(sid)

    session.setdefault("session_id", sid)
    session.setdefault("created_at", datetime.now().isoformat(timespec="seconds"))
    return session


def _quarantine(path: Path) -> None:
    """Rename an unusable session file aside so its contents survive.

    Best-effort: if the rename fails the caller still proceeds with a fresh
    session, and the write that follows overwrites the bad file. Losing a
    corrupt file is acceptable; losing the reply the user just waited for
    is not.
    """
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        path.rename(path.with_suffix(f".json.corrupt-{stamp}"))
    except OSError as e:
        log.warning("could not quarantine %s: %s", path.name, e)


def append_turn(
    session_id: str | None,
    notice_text: str,
    query: str,
    reply: str,
    model: str,
    output_file: str,
) -> str:
    """Append one turn to a session JSON file.

    If ``session_id`` is ``None``, a new 12-hex id is generated and a new
    file is created with ``created_at`` set; otherwise the existing file
    is loaded, appended to, and rewritten in full (single-writer, so a
    full rewrite is safe and trivially atomic).

    :returns: the session id that was used (echoed back to the client so
        it can include it on the next ``/generate`` call to continue the
        conversation).
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    sid = session_id or uuid.uuid4().hex[:12]
    path = _path_for(sid)

    # The whole load-append-write cycle is one critical section: reading
    # and writing under separate locks would still let two writers start
    # from the same snapshot and drop one of the turns.
    with _write_lock:
        session = _load_or_new(path, sid)

        session["turns"].append(
            {
                "timestamp": datetime.now().isoformat(timespec="seconds"),
                "model": model,
                "notice_text": notice_text,
                "query": query,
                "reply": reply,
                "output_file": output_file,
            }
        )
        session["updated_at"] = datetime.now().isoformat(timespec="seconds")

        # Write-temp-then-rename, matching paths.save_config. A crash or
        # power loss part-way through a direct write is what produces the
        # truncated files _load_or_new has to recover from; os.replace is
        # atomic, so a reader only ever sees the old file or the complete
        # new one.
        #
        # The temp name carries a unique suffix rather than a fixed
        # ".json.tmp". A shared name is its own race even under the lock:
        # any other writer in this directory — a second process, or a
        # future caller that forgets the lock — would write the same path,
        # and on Windows os.replace then fails outright with
        # PermissionError instead of quietly overwriting.
        tmp = path.with_suffix(f".json.{uuid.uuid4().hex[:8]}.tmp")
        try:
            with tmp.open("w", encoding="utf-8") as f:
                json.dump(session, f, ensure_ascii=False, indent=2)
            os.replace(tmp, path)
        except OSError:
            # Never leave a stray temp file behind on a failed write.
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    return sid
