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

* ``400`` — missing filename or empty body
* ``415`` — unsupported extension
* ``500`` — parser crashed (e.g., corrupt PDF, missing Tesseract binary)

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


@router.post("/upload")
async def upload_document(file: UploadFile = File(...)):
    """Persist the uploaded file and return its extracted plain-text content."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided.")

    ext = Path(file.filename).suffix.lower()
    if ext not in SUPPORTED_EXTS:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{ext}'. Supported: {sorted(SUPPORTED_EXTS)}",
        )

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    saved_path = UPLOAD_DIR / file.filename
    saved_path.write_bytes(data)

    try:
        text = parse_file(file.filename, data)
    except UnsupportedFileType as e:
        raise HTTPException(status_code=415, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse file: {e}")

    return {
        "filename": file.filename,
        "saved_path": str(saved_path),
        "char_count": len(text),
        "text": text,
    }
