"""Tests for degradation under failure: hung daemons, pooled connections.

These exercise the paths that only misbehave when a dependency is sick
rather than absent. A refused connection fails fast and is easy; a socket
that accepts and then goes silent is what actually wedges a client.
"""

from __future__ import annotations

import socketserver
import threading
import time

import pytest


class _BlackHoleHandler(socketserver.BaseRequestHandler):
    """Accept the connection, then never send a byte."""

    def handle(self) -> None:
        time.sleep(60)


class _ThreadedServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


@pytest.fixture()
def black_hole_port():
    """A TCP port that accepts connections and never responds."""
    srv = _ThreadedServer(("127.0.0.1", 0), _BlackHoleHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield srv.server_address[1]
    finally:
        srv.shutdown()
        srv.server_close()


class TestOllamaTimeouts:
    def test_health_returns_against_a_hung_daemon(self, black_hole_port, monkeypatch):
        """/health must never hang.

        The Electron shell polls /health to decide the backend is alive. A
        daemon that accepts the TCP connection and then never answers —
        hung, mid-restart, or a stale port forward — would stall an untimed
        probe indefinitely and take that poll down with it.
        """
        import paths
        import services.ollama_client as oc

        cfg = paths.load_config()
        original_port = cfg.get("ollama_port", 11434)
        cfg["ollama_port"] = black_hole_port
        paths.save_config(cfg)
        # Force a rebuild against the black-hole port; a client cached by an
        # earlier test would otherwise still point somewhere else.
        monkeypatch.setattr(oc, "_probe_client", None)
        monkeypatch.setattr(oc, "_chat_client", None)
        monkeypatch.setattr(oc, "_client_key", None)

        try:
            started = time.perf_counter()
            info = oc.health()
            elapsed = time.perf_counter() - started
        finally:
            cfg["ollama_port"] = original_port
            paths.save_config(cfg)

        assert elapsed < oc.PROBE_TIMEOUT_SECONDS + 10, (
            f"health() took {elapsed:.1f}s against a hung daemon — "
            "the probe deadline is not being applied"
        )
        assert info["ollama_running"] is False
        assert info["error"]

    def test_probe_and_chat_clients_have_different_deadlines(self):
        """A chat completion legitimately runs for minutes; it must not
        inherit the probe's short deadline."""
        import services.ollama_client as oc

        assert oc.CHAT_TIMEOUT_SECONDS > oc.PROBE_TIMEOUT_SECONDS

    def test_host_change_invalidates_both_clients(self, monkeypatch):
        """A config change must not leave chat pinned to the old daemon.

        Both clients are built lazily and no request is issued, so this
        never touches the network. The config is restored afterwards so a
        later test does not inherit a port that nothing is listening on —
        connecting to a closed port on Windows is slow enough to blow an
        unrelated test's timing budget.
        """
        import paths
        import services.ollama_client as oc

        cfg = paths.load_config()
        original_port = cfg.get("ollama_port", 11434)
        try:
            cfg["ollama_port"] = 11434
            paths.save_config(cfg)
            monkeypatch.setattr(oc, "_probe_client", None)
            monkeypatch.setattr(oc, "_chat_client", None)
            monkeypatch.setattr(oc, "_client_key", None)
            oc._get_client()
            oc._get_chat_client()
            assert oc._chat_client is not None

            cfg["ollama_port"] = 11435
            paths.save_config(cfg)
            oc._get_client()
            assert oc._chat_client is None, "stale chat client survived a host change"
        finally:
            cfg["ollama_port"] = original_port
            paths.save_config(cfg)


class TestRagColdStart:
    def test_empty_store_query_does_not_load_the_model(self, monkeypatch):
        """An empty vector store must short-circuit before ``_load_model``.

        Loading sentence-transformers costs tens of seconds on first use
        and, when the weights are not cached, reaches out to huggingface.co
        and retries before failing. A fresh install has an empty store
        until the first sync finishes — exactly when the user makes their
        first request — so ordering the model load ahead of the emptiness
        check put ~46 s of avoidable latency on the /generate path and
        made an offline-capable app phone home to do nothing.
        """
        import services.rag_embedder as embedder

        def _boom():
            raise AssertionError("_load_model called for an empty collection")

        monkeypatch.setattr(embedder, "_load_model", _boom)
        monkeypatch.setattr(embedder, "collection_size", lambda: 0)

        assert embedder.query("any question at all") == []

    def test_blank_query_returns_early(self):
        import services.rag_embedder as embedder

        assert embedder.query("") == []
        assert embedder.query("   \n ") == []

    def test_is_model_available_does_not_load_the_model(self, monkeypatch):
        """/rag/status is polled every 10 s by the first-run banner.

        Answering it by actually loading the model meant each poll could
        spend tens of seconds and issue outbound huggingface.co requests —
        repeatedly, in the exact state the banner exists to report, for an
        app that is meant to run offline.
        """
        import services.rag_embedder as embedder

        def _boom():
            raise AssertionError("is_model_available() loaded the model")

        monkeypatch.setattr(embedder, "_model", None)
        monkeypatch.setattr(embedder, "_load_model", _boom)

        started = time.perf_counter()
        result = embedder.is_model_available()
        elapsed = time.perf_counter() - started

        assert isinstance(result, bool)
        assert elapsed < 1.0, f"cheap check took {elapsed:.1f}s"

    def test_is_model_available_true_when_already_loaded(self, monkeypatch):
        import services.rag_embedder as embedder

        monkeypatch.setattr(embedder, "_model", object())
        assert embedder.is_model_available() is True

    def test_is_model_available_false_on_empty_cache(self, monkeypatch, tmp_path):
        import services.rag_embedder as embedder

        monkeypatch.setattr(embedder, "_model", None)
        monkeypatch.setattr(embedder, "RAG_MODELS_DIR", tmp_path / "empty")
        assert embedder.is_model_available() is False


class TestSessionStoreConcurrency:
    """``POST /generate`` is a sync endpoint, so Starlette runs it in a
    worker thread and two requests execute in parallel for real."""

    def test_concurrent_appends_do_not_lose_turns(self):
        """Every turn must survive a burst of simultaneous writers.

        Before the write lock, 40 concurrent appends left 2 turns on disk:
        writers started from the same snapshot and overwrote each other,
        ``os.replace`` failed with PermissionError because they all used
        one shared ``.tmp`` name, and a reader that caught a half-written
        file quarantined a healthy session as corrupt. The saved session
        is the audit trail for a legal document — losing turns silently is
        the worst of those outcomes.
        """
        import json

        from paths import DATA_DIR
        from services.session_store import append_turn

        session_id = "concurrentwrites"
        writers = 40
        barrier = threading.Barrier(writers)
        failures: list[BaseException] = []

        def worker(n: int) -> None:
            try:
                barrier.wait(timeout=30)
                append_turn(session_id, "notice", f"q{n}", "reply", "model", "")
            except BaseException as exc:  # noqa: BLE001 - reported below
                failures.append(exc)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(writers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)

        assert not failures, f"{len(failures)} writer(s) raised: {failures[:3]}"

        path = DATA_DIR / f"session_{session_id}.json"
        turns = json.loads(path.read_text(encoding="utf-8"))["turns"]
        assert len(turns) == writers, f"lost {writers - len(turns)} turn(s)"
        assert {t["query"] for t in turns} == {f"q{i}" for i in range(writers)}

        # A healthy session must never be quarantined as corrupt.
        assert not list(DATA_DIR.glob(f"session_{session_id}.json.corrupt-*"))

    def test_no_temp_files_are_left_behind(self):
        from paths import DATA_DIR
        from services.session_store import append_turn

        append_turn("tempfilecheck", "n", "q", "r", "m", "")
        assert not list(DATA_DIR.glob("*.tmp"))


class TestAtomicWrites:
    """Every JSON writer uses a unique temp name and a retrying replace.

    Two backends can legitimately share one BASE_DIR — the 8000→8003 port
    fallback exists so a second instance can start alongside the first,
    and both write their resolved port back to config.json.
    """

    def test_concurrent_config_writes_all_succeed(self):
        import paths

        writers = 24
        barrier = threading.Barrier(writers)
        failures: list[BaseException] = []

        def worker(n: int) -> None:
            try:
                barrier.wait(timeout=30)
                cfg = paths.load_config()
                cfg["backend_port"] = 8000 + (n % 4)
                paths.save_config(cfg)
            except BaseException as exc:  # noqa: BLE001 - reported below
                failures.append(exc)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(writers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)

        assert not failures, f"{len(failures)} writer(s) raised: {failures[:3]}"
        assert isinstance(paths.load_config(), dict)
        assert not list(paths.BASE_DIR.glob("*.tmp")), "stray temp files left behind"

    def test_config_survives_a_write_storm_intact(self):
        """The file must never be observed half-written."""
        import json

        import paths

        cfg = paths.load_config()
        cfg["backend_port"] = 8003
        paths.save_config(cfg)
        raw = json.loads(paths.CONFIG_PATH.read_text(encoding="utf-8"))
        assert raw["backend_port"] == 8003

    def test_sync_status_writers_round_trip(self):
        """The scheduler and the scraper write the same file; neither may
        destroy the other's keys."""
        import services.rag_scheduler as sched
        import services.rag_scraper as scraper

        scraper._save_known_urls({"u1", "u2"})
        sched._write_status({"last_sync_status": "success", "docs_total": 7})

        # The scheduler must preserve known_urls written by the scraper.
        assert scraper._load_known_urls() == {"u1", "u2"}
        assert sched.get_status()["last_sync_status"] == "success"
        assert sched.get_status()["docs_total"] == 7

        # And the scraper must preserve the scheduler's keys.
        scraper._save_known_urls({"u1", "u2", "u3"})
        assert sched.get_status()["docs_total"] == 7


class TestOneTimeCleanup:
    """The Waqf sweep is a migration, not a per-sync chore."""

    def test_cleanup_scans_once_then_records_a_marker(self, monkeypatch):
        import services.rag_scraper as scraper

        scans = {"n": 0}

        class _FakeCollection:
            def get(self, **kwargs):
                scans["n"] += 1
                return {"ids": [], "metadatas": []}

            def delete(self, **kwargs):  # pragma: no cover - nothing to delete
                raise AssertionError("nothing should be deleted")

        import services.rag_embedder as embedder

        monkeypatch.setattr(embedder, "_open_collection", lambda: _FakeCollection())

        scraper._cleanup_unrelated_chunks()
        assert scans["n"] == 1
        assert scraper._read_cleanup_done() is True

        # Every later sync must skip the scan entirely.
        scraper._cleanup_unrelated_chunks()
        scraper._cleanup_unrelated_chunks()
        assert scans["n"] == 1

    def test_marker_survives_known_url_writes(self, monkeypatch):
        """The scraper rewrites sync_status.json on every run; the marker
        must not be clobbered by that."""
        import services.rag_scraper as scraper

        scraper._mark_cleanup_done()
        scraper._save_known_urls({"abc", "def"})
        assert scraper._read_cleanup_done() is True


class TestIndianKanoonPooling:
    def test_pooled_session_reuses_one_connection(self):
        """A full sync issues up to 250 requests to one host. Without
        pooling that is 250 TLS handshakes; with it, one connection."""
        import http.server
        import json

        connections: list[tuple] = []

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", 0))
                self.rfile.read(length)
                body = json.dumps({"docs": []}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def setup(self) -> None:
                super().setup()
                connections.append(self.client_address)

            def log_message(self, *args) -> None:
                pass

        srv = _ThreadedServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{srv.server_address[1]}/search/"
        try:
            import services.rag_scraper as scraper

            connections.clear()
            for i in range(8):
                scraper._ik_post(url, "token", {"q": str(i)})
            unpooled = len(connections)

            connections.clear()
            with scraper._ik_session("token"):
                for i in range(8):
                    scraper._ik_post(url, "token", {"q": str(i)})
            pooled = len(connections)
        finally:
            srv.shutdown()
            srv.server_close()

        assert unpooled == 8, f"expected one connection per call, got {unpooled}"
        assert pooled == 1, f"pooled session opened {pooled} connections"

    def test_session_is_closed_and_reset_on_exit(self):
        import services.rag_scraper as scraper

        with scraper._ik_session("token"):
            assert scraper._ik_client is not None
        assert scraper._ik_client is None

    def test_session_resets_even_when_body_raises(self):
        """A crash mid-sync must not leak the pooled client into the next run."""
        import services.rag_scraper as scraper

        with pytest.raises(RuntimeError):
            with scraper._ik_session("token"):
                raise RuntimeError("sync exploded")
        assert scraper._ik_client is None
