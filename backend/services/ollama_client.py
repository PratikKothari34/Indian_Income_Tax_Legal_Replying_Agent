"""Thin wrapper around the official ``ollama`` Python client.

Responsibilities:

* Configure the spec'd primary / fallback models.
* Provide a single :func:`chat` entrypoint that transparently fails over from
  the requested model → ``qwen2.5:14b`` → ``deepseek-r1:14b`` on missing-model
  or chat error.
* Tolerate the ollama-python library returning either dicts or pydantic
  ``Model`` objects depending on installed version (see
  :func:`list_local_models`).
* Expose a :func:`health` probe so the ``/health`` route can report Ollama
  reachability + per-model availability without calling chat.

All calls go to the local Ollama daemon at ``127.0.0.1:11434``. There are
no outbound HTTP calls in this module.
"""

from __future__ import annotations

import logging
import subprocess

import ollama

log = logging.getLogger("itax.ollama")

#: Spec'd primary model — first choice for standard chat calls.
PRIMARY_MODEL = "qwen2.5:14b"

#: Spec'd fallback model — tried when the primary is missing or errors out,
#: and auto-promoted to first-choice when the task is complex and resources
#: are sufficient.
FALLBACK_MODEL = "deepseek-r1:14b"

#: VRAM / RAM thresholds the 14B models need to run comfortably. Below
#: these we still attempt the primary — the daemon will fall back to CPU
#: or fail naturally — but we log a warning so a slow / failed reply is
#: explainable.
_VRAM_THRESHOLD_GB = 10.0
_RAM_THRESHOLD_GB = 20.0

#: Keywords that flip a chat call from "standard" to "complex" and route
#: it to the deepseek-r1 reasoning model. Curated for the kinds of
#: Income-Tax notices that need careful chain-of-thought (revisional /
#: penal proceedings, search-and-seizure, international tax, etc.).
_COMPLEX_TASK_KEYWORDS: tuple[str, ...] = (
    "263", "revision", "search", "seizure", "raid",
    "penalty", "prosecution", "undisclosed", "black money",
    "transfer pricing", "international", "dtaa", "treaty",
    "reassessment", "148", "153c", "276", "277", "278",
    "survey", "271", "concealment", "bogus", "accommodation",
)

#: Long notices benefit from the slower reasoning model regardless of
#: keyword match.
_COMPLEX_TASK_LENGTH_THRESHOLD = 3000


# ---------------------------------------------------------------------------
# Resource probes — used to decide whether the host can run a 14B model.
# ---------------------------------------------------------------------------
def get_available_vram_gb() -> float:
    """Return free VRAM (GB) on the most-free GPU. ``0.0`` if no NVIDIA GPU.

    Shells out to ``nvidia-smi`` with a 5-second timeout. We deliberately
    return free memory rather than total: a system with a 12 GB GPU that's
    already 80% utilised by another process cannot host the 14B weights
    on top.
    """
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.free",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return 0.0
    if result.returncode != 0:
        return 0.0
    best_mib = 0.0
    for line in (result.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            best_mib = max(best_mib, float(line))
        except ValueError:
            continue
    # nvidia-smi reports MiB; divide by 1024 for GiB.
    return best_mib / 1024.0


def get_available_ram_gb() -> float:
    """Return free system RAM in GB via psutil. Returns ``0.0`` if psutil missing."""
    try:
        import psutil
    except ImportError:
        log.warning("[model-select] psutil not installed — RAM probe disabled")
        return 0.0
    return psutil.virtual_memory().available / (1024 ** 3)


def has_sufficient_resources_for_14b() -> bool:
    """True if either VRAM or RAM is above the 14B-model thresholds.

    Either dimension is enough: a beefy GPU (>=10 GiB free) can host the
    weights end-to-end, and a beefy CPU host (>=20 GiB free RAM) can run
    CPU inference even on a weak / absent GPU.
    """
    vram = get_available_vram_gb()
    ram = get_available_ram_gb()
    log.info("[model-select] VRAM=%.1fGB RAM=%.1fGB", vram, ram)
    return (vram >= _VRAM_THRESHOLD_GB) or (ram >= _RAM_THRESHOLD_GB)


# ---------------------------------------------------------------------------
# Task complexity detection — keyword + length heuristic on the last user turn.
# ---------------------------------------------------------------------------
def is_complex_task(messages: list[dict]) -> bool:
    """True when the last user message looks like a high-stakes proceeding.

    Two signals: any keyword from :data:`_COMPLEX_TASK_KEYWORDS` in the
    lowercased text, OR length above :data:`_COMPLEX_TASK_LENGTH_THRESHOLD`
    (long notices tend to bundle multiple issues and benefit from the
    slower reasoning model).
    """
    text = ""
    for m in reversed(messages):
        if isinstance(m, dict) and m.get("role") == "user":
            content = m.get("content") or ""
            if isinstance(content, str):
                text = content
            break
    if not text:
        return False
    if len(text) > _COMPLEX_TASK_LENGTH_THRESHOLD:
        return True
    low = text.lower()
    return any(kw in low for kw in _COMPLEX_TASK_KEYWORDS)


class OllamaUnavailable(Exception):
    """Raised when the local Ollama daemon is unreachable, or when every
    model in the fallback chain has failed (missing or chat error)."""


def list_local_models() -> list[dict]:
    """Return the list of locally pulled Ollama models.

    Each entry is ``{"name": str, "size": int|None, "modified_at": str|None}``.
    Raises :class:`OllamaUnavailable` if the daemon cannot be reached.
    """
    try:
        resp = ollama.list()
    except Exception as e:  # connection refused, etc.
        raise OllamaUnavailable(str(e)) from e

    raw = resp.get("models", []) if isinstance(resp, dict) else getattr(resp, "models", [])
    out: list[dict] = []
    for m in raw:
        # ollama-python returns either dicts or pydantic Model objects depending on version.
        if isinstance(m, dict):
            name = m.get("name") or m.get("model")
            size = m.get("size")
            modified = m.get("modified_at")
        else:
            name = getattr(m, "model", None) or getattr(m, "name", None)
            size = getattr(m, "size", None)
            modified = getattr(m, "modified_at", None)
        if name:
            out.append({"name": name, "size": size, "modified_at": str(modified) if modified else None})
    return out


def is_model_available(model: str) -> bool:
    """True if ``model`` (e.g. ``"qwen2.5:14b"``) appears in ``ollama list``.

    Matches loosely on the tag-stripped base name, so passing ``"qwen2.5"``
    will resolve against any pulled tag of that family.
    """
    try:
        models = list_local_models()
    except OllamaUnavailable:
        return False
    names = {m["name"] for m in models}
    # Allow user to pass either "qwen2.5:14b" or "qwen2.5" (match by tag-stripped prefix)
    if model in names:
        return True
    base = model.split(":")[0]
    return any(n.split(":")[0] == base for n in names)


def health() -> dict:
    """Health probe — returns Ollama reachability and model availability.

    Never raises: any error reaching Ollama is captured into the
    ``error`` field of the returned dict, and ``ollama_running`` is left
    ``False``. The ``/health`` route layers a top-level ``status`` field
    on top of this output.
    """
    info: dict = {
        "ollama_running": False,
        "primary_model": PRIMARY_MODEL,
        "primary_available": False,
        "fallback_model": FALLBACK_MODEL,
        "fallback_available": False,
        "models": [],
        "error": None,
    }
    try:
        models = list_local_models()
        info["ollama_running"] = True
        info["models"] = [m["name"] for m in models]
        info["primary_available"] = is_model_available(PRIMARY_MODEL)
        info["fallback_available"] = is_model_available(FALLBACK_MODEL)
    except OllamaUnavailable as e:
        info["error"] = str(e)
    return info


def chat(
    messages: list[dict],
    model: str | None = None,
    temperature: float = 0.2,
    auto_select: bool = True,
) -> tuple[str, str]:
    """Run a chat against Ollama, with transparent model fallback.

    Candidate order:

    1. ``model`` argument if provided, **or** the auto-selected model
       when ``auto_select=True`` and no caller override is set.
    2. :data:`PRIMARY_MODEL`.
    3. :data:`FALLBACK_MODEL`.

    Auto-selection (the new behaviour, controlled by ``auto_select``):

    * **Complex task + sufficient resources** → deepseek-r1:14b first.
    * **Standard task + sufficient resources** → qwen2.5:14b first.
    * **Insufficient resources** → qwen2.5:14b first, logged as a warning.

    The fallback chain is unchanged: whatever ends up first, if it can't
    serve the request the loop drops to the other 14B model. Duplicates
    are removed while preserving order. The first candidate to return a
    non-empty response wins.

    :returns: ``(reply_text, model_actually_used)``
    :raises OllamaUnavailable: if every candidate fails. The last
        underlying exception is wrapped into the message.
    """
    # Auto-selection: only kicks in when the caller didn't pin a model
    # explicitly. A pinned ``model`` always takes precedence — power
    # users (and our own tests) need a way to bypass the heuristic.
    if auto_select and model is None:
        if has_sufficient_resources_for_14b():
            if is_complex_task(messages):
                model = FALLBACK_MODEL
                log.info(
                    "[model-select] complex task + sufficient resources -> %s",
                    FALLBACK_MODEL,
                )
            else:
                model = PRIMARY_MODEL
                log.info("[model-select] standard task -> %s", PRIMARY_MODEL)
        else:
            model = PRIMARY_MODEL
            log.warning(
                "[model-select] insufficient resources for 14B model -- "
                "replies may be slow or fail. Consider freeing RAM/VRAM."
            )
            log.info(
                "[model-select] low resources -> attempting %s (may be slow)",
                PRIMARY_MODEL,
            )

    requested = model or PRIMARY_MODEL
    candidates: list[str] = []
    seen: set[str] = set()
    for m in (requested, PRIMARY_MODEL, FALLBACK_MODEL):
        if m and m not in seen:
            candidates.append(m)
            seen.add(m)

    last_err: Exception | None = None
    for candidate in candidates:
        if not is_model_available(candidate):
            last_err = RuntimeError(f"Model '{candidate}' not pulled locally")
            continue
        try:
            resp = ollama.chat(
                model=candidate,
                messages=messages,
                options={"temperature": temperature},
                stream=False,
            )
            content = _extract_content(resp)
            if content:
                return content, candidate
            last_err = RuntimeError(f"Empty response from model '{candidate}'")
        except Exception as e:
            last_err = e
            continue

    raise OllamaUnavailable(
        f"All model candidates failed. Last error: {last_err}"
    )


def _extract_content(resp) -> str:
    """Pull the assistant text out of an ollama-python chat response.

    The library returns ``dict`` on older versions and a pydantic
    ``ChatResponse`` on newer ones; this helper handles both shapes.
    """
    if isinstance(resp, dict):
        msg = resp.get("message") or {}
        if isinstance(msg, dict):
            return (msg.get("content") or "").strip()
        return ""
    msg = getattr(resp, "message", None)
    if msg is None:
        return ""
    content = getattr(msg, "content", None)
    return (content or "").strip()
