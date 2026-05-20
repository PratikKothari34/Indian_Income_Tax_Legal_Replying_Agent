# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the Income Tax Legal Reply Agent backend.
#
# Build with (from the project root):
#     pyinstaller backend.spec --distpath dist-backend --workpath build-backend
#
# Produces dist-backend/backend.exe — a single-file Windows executable that
# the Electron app launches via process.resourcesPath at runtime.
#
# Heavy ML libraries (chromadb, sentence_transformers, torch, transformers,
# tokenizers) need a full data + binary + hidden-import sweep because they
# carry runtime resources and submodules PyInstaller's analyzer can't infer.
# We use PyInstaller.utils.hooks.collect_all for each.
#
# Tesseract is bundled from C:\Program Files\Tesseract-OCR\ — tesseract.exe,
# every *.dll in that directory, plus tessdata/eng.traineddata. At runtime
# backend/paths.py::configure_tesseract points pytesseract at the unpacked
# binary inside sys._MEIPASS.

import os
import glob
from PyInstaller.utils.hooks import collect_all

block_cipher = None

# ---------------------------------------------------------------------------
# collect_all for heavy ML packages
# ---------------------------------------------------------------------------
_datas: list = []
_binaries: list = []
_hiddenimports: list = []

for pkg in ("chromadb", "sentence_transformers", "torch", "transformers", "tokenizers"):
    d, b, h = collect_all(pkg)
    _datas += d
    _binaries += b
    _hiddenimports += h

# ---------------------------------------------------------------------------
# Tesseract bundling (Windows default install at C:\Program Files\Tesseract-OCR)
# ---------------------------------------------------------------------------
TESSERACT_DIR = r"C:\Program Files\Tesseract-OCR"
TESSDATA_DIR = os.path.join(TESSERACT_DIR, "tessdata")
TESSERACT_EXE = os.path.join(TESSERACT_DIR, "tesseract.exe")

tesseract_binaries: list = []
tesseract_datas: list = []
if os.path.exists(TESSERACT_EXE):
    tesseract_binaries.append((TESSERACT_EXE, "."))
    for dll in glob.glob(os.path.join(TESSERACT_DIR, "*.dll")):
        tesseract_binaries.append((dll, "."))
    eng = os.path.join(TESSDATA_DIR, "eng.traineddata")
    if os.path.exists(eng):
        tesseract_datas.append((eng, "tessdata"))

# ---------------------------------------------------------------------------
# Explicit hidden imports — uvicorn / fastapi / parser libs / RAG stack.
# Many of these are dynamically referenced and won't be picked up by the
# analyzer without help.
# ---------------------------------------------------------------------------
extra_hiddenimports = [
    # uvicorn protocol + lifespan plumbing
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    # FastAPI + Starlette
    "fastapi",
    "fastapi.middleware",
    "fastapi.middleware.cors",
    "starlette",
    "starlette.middleware",
    "starlette.routing",
    # async backend
    "anyio",
    "anyio._backends._asyncio",
    # PDF parser (pdfplumber pulls pdfminer.six)
    "pdfplumber",
    "pdfminer",
    "pdfminer.six",
    "pdfminer.high_level",
    "pdfminer.layout",
    "pdfminer.converter",
    "pdfminer.pdfpage",
    # Word / Excel / OCR
    "docx",
    "docx.oxml",
    "docx.oxml.ns",
    "openpyxl",
    "openpyxl.styles",
    "openpyxl.utils",
    "xlrd",
    "xlrd.biffh",
    "PIL",
    "PIL.Image",
    "PIL.ImageOps",
    "pytesseract",
    # Ollama client
    "ollama",
    # multipart for FastAPI form uploads
    "multipart",
    "python_multipart",
    # RAG scheduler
    "apscheduler",
    "apscheduler.schedulers.asyncio",
    "apscheduler.triggers.cron",
    "apscheduler.executors.pool",
    # HTTP + HTML
    "httpx",
    "bs4",
    "lxml",
    # ML support
    "sklearn",
    "sklearn.metrics",
    "sklearn.preprocessing",
    "huggingface_hub",
    # Resource probe for auto-model-select
    "psutil",
]
_hiddenimports += extra_hiddenimports

# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------
a = Analysis(
    ["backend/main.py"],
    pathex=["backend"],
    binaries=_binaries + tesseract_binaries,
    datas=_datas + tesseract_datas,
    hiddenimports=_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # We're CPU-or-Ollama-side only; never bundle CUDA DLLs. Ollama
        # manages its own GPU. Excluding these shaves substantial bulk
        # off the resulting .exe.
        "torch.cuda",
        "torch.backends.cudnn",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# ---------------------------------------------------------------------------
# Single-file executable, no console window (Electron wraps the process).
# ---------------------------------------------------------------------------
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
