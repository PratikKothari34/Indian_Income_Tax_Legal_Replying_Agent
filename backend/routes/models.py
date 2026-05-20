"""``GET /models`` — list locally pulled Ollama models.

Returned shape::

    {
      "primary":  "qwen2.5:14b",
      "fallback": "deepseek-r1:14b",
      "models": [
        {"name": "qwen2.5:14b", "size": 9000000000, "modified_at": "..."},
        ...
      ]
    }

The Electron frontend uses this list to populate a model-picker dropdown.
The user's selection is then passed verbatim as the ``model`` field of
``POST /generate``; the backend will fall back to the spec'd primary /
fallback if the chosen model is unavailable at chat time.

Returns HTTP 503 if Ollama is unreachable on ``localhost:11434``.
"""

from fastapi import APIRouter, HTTPException

from services.ollama_client import (
    FALLBACK_MODEL,
    PRIMARY_MODEL,
    OllamaUnavailable,
    list_local_models,
)

router = APIRouter()


@router.get("/models")
def get_models():
    """Return the list of locally pulled Ollama models, plus the
    backend's configured primary and fallback model names."""
    try:
        models = list_local_models()
    except OllamaUnavailable as e:
        raise HTTPException(
            status_code=503,
            detail=f"Ollama is not reachable on localhost: {e}",
        )
    return {
        "primary": PRIMARY_MODEL,
        "fallback": FALLBACK_MODEL,
        "models": models,
    }
