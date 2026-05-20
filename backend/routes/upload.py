"""``POST /upload`` — accept a notice file, persist it, return extracted text.

Accepts multipart/form-data with a single field ``file``. Supported types:

==============  ===========================
Extension       Parser
==============  ===========================
``.pdf``        ``pdfplumber``
``.docx``       ``python-docx``
``.xlsx``       ``openpyxl`` (read-only)
``.xls``        ``xlrd`` (legacy format)
``.jpg/.jpeg``  ``pytesseract`` + Pillow OCR
``.png``        ``pytesseract`` + Pillow OCR
==============  ===========================

Returned shape::

    {
      "filename":   "notice.pdf",
      "saved_path": "<abs path under backend/uploads/>",
      "char_count": 4321,
      "text":       "<extracted plain text, ready to feed into /generate>"
    }

HTTP errors:

* ``400`` — missing filename, null byte in filename, or empty body
* ``413`` — file exceeds the 25 MiB upload limit
* ``415`` — unsupported extension, or content does not match the extension
* ``500`` — parser crashed (e.g., corrupt PDF, missing Tesseract binary)

Security: the client-supplied filename is reduced to a bare basename and
the saved path is confirmed to resolve directly inside ``backend/uploads/``,
so a traversal payload (``../../...``) or an absolute path cannot write
elsewhere. File content is sniffed against the claimed extension so a
renamed binary is rejected before it is persisted.

The extracted text is what the Electron frontend then forwards to
``POST /generate`` as the ``text`` field. The original file is also
persisted to ``backend/uploads/`` so the user can re-parse or audit
later without re-uploading.
"""

from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from paths import UPLOADS_DIR as UPLOAD_DIR
from services.parser import SUPPORTED_EXTS, UnsupportedFileType, parse_file

router = APIRouter()

#: Hard cap on accepted upload size. Income-tax notices, computation
#: spreadsheets, and scanned-page images are all well under this; the
#: limit exists so a malformed or hostile upload cannot exhaust memory
#: or disk. The body is read one byte past the cap so an oversized file
#: is rejected without ever being fully buffered.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MiB

#: Magic-byte signatures keyed by extension. The route sniffs real file
#: content against the claimed extension, so a renamed binary (e.g.
#: ``malware.exe`` -> ``notice.pdf``) is rejected before being saved.
#: ``.docx`` and ``.xlsx`` are both ZIP containers (``PK\x03\x04``) and
#: share one signature; the format-specific parser rejects a genuine
#: docx/xlsx mismatch afterwards.
_MAGIC: dict[str, tuple[bytes, ...]] = {
    ".pdf": (b"%PDF",),
    ".docx": (b"PK\x03\x04",),
    ".xlsx": (b"PK\x03\x04",),
    ".xls": (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",),
    ".jpg": (b"\xff\xd8\xff",),
    ".jpeg": (b"\xff\xd8\xff",),
    ".png": (b"\x89PNG\r\n\x1a\n",),
}


def _content_matches_ext(ext: str, data: bytes) -> bool:
    """Return True if the file's leading bytes match the claimed extension."""
    signatures = _MAGIC.get(ext)
    if not signatures:
        return False
    if ext == ".pdf":
        # Per the PDF spec the %PDF marker sits within the first 1 KiB,
        # occasionally after a few leading bytes rather than at offset 0.
        return b"%PDF" in data[:1024]
    return any(data.startswith(sig) for sig in signatures)


@router.post("/upload")
async def upload_document(file: UploadFile = File(...)):
    """Persist the uploaded file and return its extracted plain-text content."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided.")
    if "\x00" in file.filename:
        raise HTTPException(status_code=400, detail="Filename contains a null byte.")

    # Strip every directory component — the saved name is always a bare
    # basename inside UPLOAD_DIR. This defuses traversal payloads such as
    # "../../backend/output/x.docx" and absolute paths like "C:\\...\\x.pdf".
    safe_name = Path(file.filename).name
    ext = Path(safe_name).suffix.lower()
    if not safe_name or ext not in SUPPORTED_EXTS:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{ext}'. Supported: {sorted(SUPPORTED_EXTS)}",
        )

    # Read with a hard cap: request one byte past the limit so an
    # oversized upload is detected without buffering the whole body.
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB upload limit.",
        )

    # Content sniffing — reject a file whose real bytes do not match its
    # claimed extension (e.g. an executable renamed to .pdf).
    if not _content_matches_ext(ext, data):
        raise HTTPException(
            status_code=415,
            detail=f"File content does not match its '{ext}' extension.",
        )

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    upload_root = UPLOAD_DIR.resolve()
    saved_path = (upload_root / safe_name).resolve()
    # Defence in depth: the resolved target must sit directly inside
    # UPLOAD_DIR even after normalisation / symlink resolution.
    if saved_path.parent != upload_root:
        raise HTTPException(status_code=400, detail="Invalid file path.")
    saved_path.write_bytes(data)

    try:
        text = parse_file(safe_name, data)
    except UnsupportedFileType as e:
        raise HTTPException(status_code=415, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse file: {e}")

    return {
        "filename": safe_name,
        "saved_path": str(saved_path),
        "char_count": len(text),
        "text": text,
    }
