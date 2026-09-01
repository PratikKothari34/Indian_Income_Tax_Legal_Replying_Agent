"""Shared pytest fixtures.

Every test runs against a throwaway ``BASE_DIR`` under ``tmp_path``, never
the developer's real ``backend/`` tree. This matters because ``config.json``
in a working checkout holds a live Indian Kanoon API token: an import of
``paths`` that resolved to the real directory would let a test read, rewrite
or truncate it.

The isolation is installed via ``ITAX_BASE_DIR_OVERRIDE`` (honoured by
``paths._resolve_base_dir``) and applied at session scope, before any test
module imports the app.
"""

from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


@pytest.fixture(scope="session", autouse=True)
def isolated_base_dir(tmp_path_factory) -> Path:
    """Point every path constant at a temp tree for the whole session."""
    base = tmp_path_factory.mktemp("itax_base")
    os.environ["ITAX_BASE_DIR_OVERRIDE"] = str(base)
    # Re-import so module-level constants (BASE_DIR, DATA_DIR, ...) pick
    # the override up. Anything already imported is dropped first.
    for name in [m for m in list(sys.modules) if m.startswith(("paths", "services", "routes"))]:
        del sys.modules[name]
    import paths

    importlib.reload(paths)
    assert paths.BASE_DIR == base, f"isolation failed: {paths.BASE_DIR}"
    yield base
    os.environ.pop("ITAX_BASE_DIR_OVERRIDE", None)


@pytest.fixture(autouse=True)
def no_ollama(monkeypatch):
    """Fail Ollama calls immediately instead of waiting on the network.

    Tests that assert on a middleware verdict (403 vs not-403) or on
    request validation still execute the route body whenever the request
    is allowed through. With no daemon listening, each such test would
    burn a connect timeout per model candidate — seconds of waiting for a
    result the test never inspects, and a suite whose runtime depends on
    whether the developer happens to have Ollama running.

    Autouse so no test has to opt in. The handful of tests that need the
    real client (see ``test_resilience``) reach for it explicitly through
    the module rather than these patched names.
    """
    import services.ollama_client as oc

    def _unavailable(*args, **kwargs):
        raise oc.OllamaUnavailable("stubbed: no Ollama daemon under test")

    monkeypatch.setattr("routes.generate.chat", _unavailable, raising=False)
    return None


@pytest.fixture()
def client(isolated_base_dir):
    """A Starlette TestClient over the real FastAPI app.

    The RAG scheduler is neutered — its startup hook would otherwise kick
    off a live network sync the moment the TestClient context opens.
    """
    from starlette.testclient import TestClient

    import services.rag_scheduler as sched

    original = sched.init_scheduler
    sched.init_scheduler = lambda app: None
    try:
        if "main" in sys.modules:
            del sys.modules["main"]
        import main

        importlib.reload(main)
        # base_url pins the Host header to a loopback name. TestClient
        # otherwise sends "Host: testserver", which main.local_origin_guard
        # correctly rejects with 403 — every request in the suite would fail
        # for that reason alone and mask the behaviour under test.
        # TestHostGuard overrides this per-request to exercise the guard.
        with TestClient(main.app, base_url="http://127.0.0.1:8000") as c:
            yield c
    finally:
        sched.init_scheduler = original
