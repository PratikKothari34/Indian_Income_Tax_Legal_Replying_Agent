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
import uuid
from datetime import datetime
from pathlib import Path

from paths import DATA_DIR


def _path_for(session_id: str) -> Path:
    return DATA_DIR / f"session_{session_id}.json"


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

    if path.exists():
        with path.open("r", encoding="utf-8") as f:
            session = json.load(f)
    else:
        session = {
            "session_id": sid,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "turns": [],
        }

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

    with path.open("w", encoding="utf-8") as f:
        json.dump(session, f, ensure_ascii=False, indent=2)

    return sid
