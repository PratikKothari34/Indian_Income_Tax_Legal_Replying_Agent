"""``GET /health`` — backend liveness + Ollama readiness probe.

Returned shape::

    {
      "status":             "ok" | "degraded",
      "ollama_running":     bool,
      "primary_model":      "qwen2.5:14b",
      "primary_available":  bool,
      "fallback_model":     "deepseek-r1:14b",
      "fallback_available": bool,
      "models":             ["<model:tag>", ...],
      "error":              str | null
    }

``status`` is ``"ok"`` only when Ollama is reachable AND at least one of the
primary/fallback models is pulled locally; otherwise ``"degraded"``. Used by
the Electron frontend on launch to decide whether to enable the
"Generate" button.
"""

from fastapi import APIRouter

from services.ollama_client import health

router = APIRouter()


@router.get("/health")
def get_health():
    """Probe Ollama and report model availability."""
    info = health()
    info["status"] = "ok" if info["ollama_running"] and (
        info["primary_available"] or info["fallback_available"]
    ) else "degraded"
    return info
