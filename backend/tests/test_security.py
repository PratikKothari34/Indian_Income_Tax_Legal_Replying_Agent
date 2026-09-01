"""Security regression tests for the local HTTP surface.

Covers the two middleware gates in ``main.py`` (host pinning and the
cross-origin auth token), the upload route's traversal / content-sniffing
defences, and the validators that keep a client-supplied ``session_id`` or
``model`` from escaping their intended directories.

Each of these guards exists because of a specific attack:

* Host pinning kills DNS rebinding — a hostile page that resolves its own
  domain to 127.0.0.1 and then talks to this backend.
* The ``X-ITax-Auth`` gate kills drive-by CSRF — a "simple" cross-origin
  POST needs no preflight, so binding to loopback alone does not stop it.
* Upload traversal / magic-byte checks stop a renamed binary or a
  ``../..`` filename from writing outside ``uploads/``.
"""

from __future__ import annotations

import io
import zipfile

import pytest

# A minimal but genuinely valid single-page PDF — pdfplumber must be able
# to open it, so the magic bytes alone are not enough.
MINIMAL_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n"
    b"trailer<</Root 1 0 R>>\n"
    b"%%EOF\n"
)


def _docx_bytes(with_doctype: bool = False) -> bytes:
    """Build a minimal .docx (a ZIP of XML parts), optionally XXE-laden."""
    doc_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>"
    )
    if with_doctype:
        doc_xml = (
            '<?xml version="1.0"?>'
            '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///c:/windows/win.ini">]>'
            + doc_xml
        )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types/>')
        zf.writestr("word/document.xml", doc_xml)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Host pinning — anti DNS-rebinding
# ---------------------------------------------------------------------------
class TestHostGuard:
    def test_loopback_host_allowed(self, client):
        assert client.get("/health", headers={"Host": "127.0.0.1:8000"}).status_code == 200

    def test_localhost_host_allowed(self, client):
        assert client.get("/health", headers={"Host": "localhost:8000"}).status_code == 200

    @pytest.mark.parametrize(
        "host",
        ["evil.com", "attacker.example:8000", "127.0.0.1.nip.io", "0.0.0.0"],
    )
    def test_foreign_host_rejected(self, client, host):
        """A rebound hostname must be refused even on a read-only route."""
        r = client.get("/health", headers={"Host": host})
        assert r.status_code == 403
        assert "Forbidden host" in r.json()["detail"]


# ---------------------------------------------------------------------------
# Cross-origin write gate — anti drive-by CSRF
# ---------------------------------------------------------------------------
class TestOriginGuard:
    def test_no_origin_is_allowed(self, client):
        """Local tooling (curl, httpx, the smoke test) sends no Origin."""
        r = client.post("/generate", json={"query": "hi"})
        assert r.status_code != 403

    def test_hostile_origin_without_token_rejected(self, client):
        r = client.post(
            "/generate",
            json={"query": "hi"},
            headers={"Origin": "https://evil.example"},
        )
        assert r.status_code == 403
        assert "auth token" in r.json()["detail"].lower()

    def test_null_origin_without_token_rejected(self, client):
        """A sandboxed iframe also presents Origin: null — the packaged
        renderer is distinguished by holding the token, not by its origin."""
        r = client.post(
            "/generate", json={"query": "hi"}, headers={"Origin": "null"}
        )
        assert r.status_code == 403

    def test_null_origin_with_token_passes_guard(self, client):
        from paths import ensure_auth_token

        r = client.post(
            "/generate",
            json={"query": "hi"},
            headers={"Origin": "null", "X-ITax-Auth": ensure_auth_token()},
        )
        assert r.status_code != 403

    def test_wrong_token_rejected(self, client):
        r = client.post(
            "/generate",
            json={"query": "hi"},
            headers={"Origin": "null", "X-ITax-Auth": "0" * 64},
        )
        assert r.status_code == 403

    def test_trusted_dev_origin_needs_no_token(self, client):
        r = client.post(
            "/generate",
            json={"query": "hi"},
            headers={"Origin": "http://127.0.0.1:5173"},
        )
        assert r.status_code != 403

    def test_get_is_never_gated(self, client):
        """Read-only routes carry no side effects, so no token is required."""
        r = client.get("/rag/status", headers={"Origin": "https://evil.example"})
        assert r.status_code == 200

    def test_destructive_rag_routes_are_gated(self, client):
        """/rag/sync and /rag/reindex mutate state and wipe the vector
        store — a hostile page must not be able to trigger either."""
        for path in ("/rag/sync", "/rag/reindex"):
            r = client.post(path, headers={"Origin": "https://evil.example"})
            assert r.status_code == 403, path


# ---------------------------------------------------------------------------
# Body size cap
# ---------------------------------------------------------------------------
class TestBodyLimit:
    def test_oversized_generate_body_rejected(self, client):
        import main

        r = client.post(
            "/generate",
            content=b"x" * 32,
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(main.MAX_GENERATE_BODY_BYTES + 1),
            },
        )
        assert r.status_code == 413

    def test_normal_body_passes(self, client):
        assert client.post("/generate", json={"query": "hi"}).status_code != 413


# ---------------------------------------------------------------------------
# Upload route
# ---------------------------------------------------------------------------
class TestUpload:
    def test_traversal_filename_is_flattened(self, client):
        """A ``../..`` filename must land in uploads/, not escape it."""
        from paths import UPLOADS_DIR

        r = client.post(
            "/upload",
            files={"file": ("../../../evil.pdf", MINIMAL_PDF, "application/pdf")},
        )
        assert r.status_code == 200
        saved = r.json()["saved_path"]
        assert UPLOADS_DIR.resolve() == __import__("pathlib").Path(saved).resolve().parent

    def test_absolute_windows_path_is_flattened(self, client):
        from paths import UPLOADS_DIR

        r = client.post(
            "/upload",
            files={"file": (r"C:\windows\temp\evil.pdf", MINIMAL_PDF, "application/pdf")},
        )
        assert r.status_code == 200
        parent = __import__("pathlib").Path(r.json()["saved_path"]).resolve().parent
        assert parent == UPLOADS_DIR.resolve()

    def test_null_byte_filename_is_neutralised(self, client):
        """A NUL in the filename must never reach the filesystem.

        The route carries an explicit ``"\\x00" in filename`` rejection, but
        that check does not fire here: python-multipart percent-encodes the
        NUL to the literal text ``%00`` while parsing the part header, so the
        route only ever sees a safe name. Either outcome is acceptable — a
        400, or a save under a sanitised name — so long as no NUL lands in
        the path, where it could truncate the name at the OS layer.
        """
        import pathlib

        from paths import UPLOADS_DIR

        r = client.post(
            "/upload", files={"file": ("evil\x00.pdf", MINIMAL_PDF, "application/pdf")}
        )
        if r.status_code == 400:
            return
        assert r.status_code == 200
        saved = pathlib.Path(r.json()["saved_path"])
        assert "\x00" not in str(saved)
        assert saved.resolve().parent == UPLOADS_DIR.resolve()

    def test_renamed_executable_rejected(self, client):
        """An MZ binary renamed to .pdf must not be persisted."""
        r = client.post(
            "/upload",
            files={"file": ("notice.pdf", b"MZ\x90\x00" + b"\x00" * 512, "application/pdf")},
        )
        assert r.status_code == 415
        assert "does not match" in r.json()["detail"]

    def test_unsupported_extension_rejected(self, client):
        r = client.post("/upload", files={"file": ("x.exe", b"MZ\x90\x00", "application/octet-stream")})
        assert r.status_code == 415

    def test_empty_file_rejected(self, client):
        r = client.post("/upload", files={"file": ("x.pdf", b"", "application/pdf")})
        assert r.status_code == 400

    def test_oversized_upload_rejected(self, client):
        from routes.upload import MAX_UPLOAD_BYTES

        blob = b"%PDF-" + b"0" * MAX_UPLOAD_BYTES
        r = client.post("/upload", files={"file": ("big.pdf", blob, "application/pdf")})
        assert r.status_code == 413

    def test_xxe_docx_rejected(self, client):
        """A DOCTYPE/ENTITY declaration in an OOXML part is treated as hostile."""
        r = client.post(
            "/upload",
            files={
                "file": (
                    "x.docx",
                    _docx_bytes(with_doctype=True),
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
            },
        )
        assert r.status_code == 415
        assert "XXE" in r.json()["detail"] or "entity" in r.json()["detail"].lower()

    def test_filename_collision_does_not_overwrite(self, client):
        """Two uploads of the same name must both survive — the saved file
        is the audit trail for a legal document."""
        first = client.post(
            "/upload", files={"file": ("notice.pdf", MINIMAL_PDF, "application/pdf")}
        )
        second = client.post(
            "/upload", files={"file": ("notice.pdf", MINIMAL_PDF, "application/pdf")}
        )
        assert first.status_code == second.status_code == 200
        assert first.json()["saved_path"] != second.json()["saved_path"]


# ---------------------------------------------------------------------------
# Request-model validators
# ---------------------------------------------------------------------------
class TestGenerateValidators:
    @pytest.mark.parametrize(
        "sid",
        ["../../../etc/passwd", "a" * 65, "has space", "semi;colon", "dot.dot", "sl/ash"],
    )
    def test_bad_session_id_rejected(self, client, sid):
        r = client.post("/generate", json={"query": "hi", "session_id": sid})
        assert r.status_code == 422

    @pytest.mark.parametrize("sid", ["abc123", "a-b_c", "A" * 64])
    def test_good_session_id_accepted(self, client, sid):
        r = client.post("/generate", json={"query": "hi", "session_id": sid})
        assert r.status_code != 422

    @pytest.mark.parametrize(
        "model",
        ["../evil", "a" * 200, "model;rm -rf", "-flag", "ns/../x", "mo del"],
    )
    def test_bad_model_rejected(self, client, model):
        r = client.post("/generate", json={"query": "hi", "model": model})
        assert r.status_code == 422

    @pytest.mark.parametrize("model", ["qwen2.5:14b", "library/qwen2.5:14b", "llama3"])
    def test_good_model_accepted(self, client, model):
        r = client.post("/generate", json={"query": "hi", "model": model})
        assert r.status_code != 422

    def test_empty_request_rejected(self, client):
        r = client.post("/generate", json={"text": "  ", "query": ""})
        assert r.status_code == 400

    @pytest.mark.parametrize("temp", [-0.1, 1.1, 99])
    def test_temperature_out_of_range_rejected(self, client, temp):
        r = client.post("/generate", json={"query": "hi", "temperature": temp})
        assert r.status_code == 422
