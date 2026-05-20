# TaxDraft India — Income Tax Legal Reply Agent

<!-- Badges -->
![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)
![Platform: Windows](https://img.shields.io/badge/Platform-Windows-blue)
![Python](https://img.shields.io/badge/Python-3.11-green)
![Electron](https://img.shields.io/badge/Electron-37-blue)
![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)

> A fully local Windows desktop application for Indian income tax
> professionals to draft formal replies to ITD notices using
> local LLMs, RAG, and automatic legal document sync.

---

## Features

- **Fully local** — no data leaves your machine, no cloud API
- **LLM-powered replies** — qwen2.5:14b for standard notices,
  deepseek-r1:14b for complex cases (auto-selected)
- **RAG pipeline** — 2000+ chunks from IT Act 2025, IT Act 1961,
  Finance Acts, CBDT circulars indexed via Indian Kanoon API
- **Auto-sync** — daily noon sync fetches latest legal updates
- **Multi-format input** — PDF, DOCX, XLS, XLSX, JPG, PNG
- **Excel-aware** — understands computation sheets, Form 26AS,
  TDS reconciliation data
- **Save as .docx** — formal letter output in Times New Roman
- **System tray** — runs in background, syncs at noon daily
- **Security hardened** — path traversal, XXE, prompt injection,
  RAG poisoning protections

---

## Screenshots

> Screenshots coming soon

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Electron 37 + React + TypeScript + Vite |
| Backend | Python 3.11 + FastAPI + Uvicorn |
| LLM | Ollama (qwen2.5:14b + deepseek-r1:14b) |
| RAG | ChromaDB + sentence-transformers (all-MiniLM-L6-v2) |
| Legal Data | Indian Kanoon API |
| OCR | Tesseract |
| Packaging | PyInstaller + electron-builder + NSIS |

---

## Prerequisites

### Build machine (developer)
- Windows 10/11 x64
- Python 3.10+ in PATH
- Node.js 24.x in PATH
- Tesseract OCR from UB Mannheim at default path
- Internet connection

### Deploy machine (end user)
- Windows 10/11 x64
- Minimum 32GB RAM (for 14B model inference)
- NVIDIA GPU recommended (RTX series)
- Internet for first-time model download (~18GB)

---

## Building from Source

```bash
# Clone the repository
git clone https://github.com/PratikKothari34/Indian_Income_Tax_Legal_Replying_Agent.git
cd Indian_Income_Tax_Legal_Replying_Agent

# Run build script (as Administrator)
.\build.bat
```

Output: `dist\ITaxReplyAgent-Setup.exe`

---

## Installation (Deploy Machine)

1. Add Windows Defender exclusion for the installer
2. Right-click installer → Properties → Unblock → OK
3. Run `ITaxReplyAgent-Setup.exe` as Administrator
4. Fill config page:
   - Ollama host/port (defaults fine)
   - Indian Kanoon API token (free at
     [api.indiankanoon.org](https://api.indiankanoon.org))
5. Wait for model downloads (~18GB, needs internet)
6. First launch downloads embedding model (~90MB)
7. After that — **fully offline**

---

## Indian Kanoon API Token

Required for automatic legal document sync.

1. Sign up at [api.indiankanoon.org](https://api.indiankanoon.org)
2. Request **non-commercial** use verification
3. Use description: "Local income tax reply tool for CA firm,
   no data redistribution, internal use only"
4. Enter token during install or via Settings panel

Non-commercial accounts get free ₹10,000/month credits.
At ₹0.20/document this covers ~50,000 document fetches/month.

---

## Usage

1. Launch app (or find in system tray)
2. Upload notice: PDF, DOCX, XLS, XLSX, JPG, or PNG
3. Type query: "Draft a formal para-wise reply to this notice"
4. Click **Generate Reply**
5. Review the generated reply
6. Click **Save as .docx** when satisfied

### Supported Notice Types
- Section 143(1) — Intimation
- Section 143(2) — Scrutiny
- Section 148/148A — Reassessment
- Section 263 — Revision
- Section 271 — Penalty
- Search and seizure notices
- TDS/TCS discrepancy notices
- DTAA and transfer pricing matters

---

## RAG Library

The app automatically syncs legal documents daily at noon:
- IT Act 2025 (section-wise)
- IT Act 1961 (key sections)
- Finance Acts
- IT Rules 1962
- CBDT circulars/notifications (manual PDF drop)

To add CBDT circulars manually:
Drop PDFs into `AppData\Local\ITaxReplyAgent\rag\docs\`
then click **Sync now** in the RAG Library panel.

---

## Development Setup

```bash
# Backend
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000

# Frontend (new terminal)
cd frontend
npm install
.\start.bat
```

---

## Project Structure

```
├── backend/
│   ├── main.py              # FastAPI entry point
│   ├── routes/              # API endpoints
│   ├── services/            # Business logic
│   │   ├── ollama_client.py # LLM with auto model selection
│   │   ├── rag_scraper.py   # Indian Kanoon API scraper
│   │   ├── rag_embedder.py  # ChromaDB + embeddings
│   │   └── parser.py        # PDF/DOCX/Excel/Image parsing
│   └── requirements.txt
├── frontend/
│   ├── electron/            # Electron main + preload
│   ├── src/                 # React components
│   └── package.json
├── installer/
│   └── installer.nsh        # NSIS installer script
├── backend.spec             # PyInstaller spec
├── build.bat                # Build script
└── README.md
```

---

## Security

This application has undergone a red-team security audit:
- Path traversal protection on file uploads
- XXE guard on DOCX/XLSX parsing
- Prompt injection and RAG poisoning defenses
- IPC channel validation
- Session ID injection prevention
- Magic-byte file type verification
- Token masking in logs and API responses

See git history for detailed security commit notes.

---

## Contributing

Contributions welcome. Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

For major changes, open an issue first.

---

## License

This project is licensed under the GNU General Public License v3.0.
See [LICENSE](LICENSE) for details.

---

## Author

**Pratik V Kothari**
- GitHub: [@PratikKothari34](https://github.com/PratikKothari34)
- Firm: RKVT AND CO, Chartered Accountants, Chennai

---

## Acknowledgements

- [Ollama](https://ollama.com) — local LLM runtime
- [Indian Kanoon](https://indiankanoon.org) — legal database API
- [ChromaDB](https://trychroma.com) — vector database
- [FastAPI](https://fastapi.tiangolo.com) — backend framework
- [Electron](https://electronjs.org) — desktop framework
