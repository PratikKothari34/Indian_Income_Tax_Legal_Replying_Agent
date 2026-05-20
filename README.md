# Income Tax Legal Reply Agent — Build & Deploy

A fully local Windows 11 desktop app that drafts formal replies to Indian
Income Tax notices. FastAPI backend + Ollama LLMs (qwen2.5:14b primary,
deepseek-r1:14b fallback) + Electron + React frontend, packaged into a single
NSIS installer.

> **Build machine** is Pratik's laptop (RTX 4060 8 GB / 16 GB RAM, Node 24).
> **Deploy machine** is a separate 32 GB RAM Windows 11 box. The installer
> produced by `build.bat` is meant for the deploy machine only — running it
> on the build machine will OOM during model load.

---

## Repository layout

```
Indian_Income_Tax_Legal_Replying_Agent/
├── backend/                  Python FastAPI + Ollama client
│   ├── main.py               entrypoint (paths via %LOCALAPPDATA%)
│   ├── paths.py              config + dirs + log + tesseract bootstrap
│   ├── routes/, services/    domain code (unchanged from spec)
│   ├── requirements.txt
│   └── .venv/                created on first build
├── frontend/                 Electron + React + Vite
│   ├── electron/             main.ts, preload.ts (window.localAgent)
│   ├── src/                  React components, hooks, types
│   └── package.json          merged electron-builder config
├── installer/
│   └── installer.nsh         NSIS hooks: config page, Ollama, models
├── backend.spec              PyInstaller spec (with hidden imports + Tesseract)
├── build.bat                 anchors via %~dp0
├── dist-backend/             produced by PyInstaller
└── dist/                     produced by electron-builder (final installer)
```

---

## Prerequisites (build machine)

- **Python 3.10+** in `PATH`.
- **Node.js 24.x** in `PATH` (tested with 24.15.0).
- **Tesseract OCR (UB Mannheim)** installed at the default path `C:\Program Files\Tesseract-OCR\`. The build script bundles `tesseract.exe`, every DLL in that directory, and `tessdata\eng.traineddata` into the resulting `backend.exe`. Get the installer from <https://github.com/UB-Mannheim/tesseract/wiki>.
- **Internet connection** during the first build (PyInstaller will pull a few transitive wheels; `npm` will install electron-builder@25.1.8 if missing).

The deploy machine does **not** need Python, Node, or Tesseract — everything is statically packaged.

---

## Build the installer

```cmd
cd C:\Users\prati\OneDrive\Desktop\My_Projects\Indian_Income_Tax_Legal_Replying_Agent
build.bat
```

`build.bat` is `%~dp0`-anchored, so the working directory does not matter. It will:

1. Verify Python, Node, PyInstaller, and `electron-builder@25.1.8` in `frontend/` (installing the latter if absent).
2. Bail with an actionable error if Tesseract is not at the expected path.
3. Create `backend\.venv` if missing and `pip install -r backend\requirements.txt`.
4. Run `pyinstaller backend.spec` → `dist-backend\backend.exe`.
5. Run `npm run build` in `frontend/` (Vite + tsc).
6. Run `npx electron-builder --win --x64` → `dist\ITaxReplyAgent-Setup.exe`.
7. Print SHA256, file size, and deploy reminders.

Expect 10–15 minutes for a cold build (Torch + chromadb dominate). Any failed step exits non-zero; re-run after fixing.

The output is `dist\ITaxReplyAgent-Setup.exe`.

---

## Deploy on the 32GB target machine

> **Do NOT run the installer on the build machine** if it has 8GB VRAM — the 14B models will OOM. Pratik's RTX 4060 laptop is for building only.

### Pre-flight

1. **Add a Windows Defender exclusion** *before* running the installer. PyInstaller binaries routinely trigger heuristic false positives.

   ```powershell
   # In an elevated PowerShell:
   Add-MpPreference -ExclusionPath "C:\Program Files\ITaxReplyAgent"
   Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\ITaxReplyAgent"
   Add-MpPreference -ExclusionPath "$env:USERPROFILE\Downloads\ITaxReplyAgent-Setup.exe"
   ```

   Or via UI: **Windows Security → Virus & threat protection → Manage settings → Add or remove exclusions**.

2. **SmartScreen bypass** — the installer is not code-signed. Right-click `ITaxReplyAgent-Setup.exe` → **Properties** → check **Unblock** → **OK**. Alternatively, when the SmartScreen "Windows protected your PC" prompt appears: **More info → Run anyway**.

3. Verify the file matches the build SHA256:

   ```cmd
   certutil -hashfile ITaxReplyAgent-Setup.exe SHA256
   ```

### Run the installer

Run as **Administrator** (right-click → Run as administrator). Eleven steps:

1. **Welcome**
2. **License**
3. **Configuration page** — Ollama host (`127.0.0.1`), Ollama port (`11434`), Backend port (`8000`), Model storage path (`%USERPROFILE%\.ollama\models`), and the optional **Indian Kanoon API Token** (masked field; leave blank to disable auto-fetch).
4. **Installation directory** — defaults to `C:\Program Files\ITaxReplyAgent\`.
5. **Disk space check** — install drive ≥ 500 MB, model drive ≥ 25 GB. Insufficient space blocks Next; pick another path and recheck.
6. **Ollama check + install** — looks for `ollama` on PATH, then `%LOCALAPPDATA%\Programs\Ollama`, then `%PROGRAMFILES%\Ollama`, then the `Ollama` Windows service. If none found, downloads `OllamaSetup.exe` from <https://ollama.com/download/OllamaSetup.exe> (inetc with 3-retry, ≥50 MB sanity check) and runs `/S` silent install.
7. **Model pull** — `qwen2.5:14b` first, then `deepseek-r1:14b`. Each: skipped if already present; pulled with up to 3 retries; a persistent failure is logged + skipped (does not abort install). About **~18 GB total** download — needs a stable connection.
8. **Install app files** to `C:\Program Files\ITaxReplyAgent\`.
9. **Write config** to `%LOCALAPPDATA%\ITaxReplyAgent\config.json` (and seed `port.txt`).
10. **Create shortcuts** — Desktop ("ITax Reply Agent") and Start Menu.
11. **Finish** — app launches automatically.

### First run

- **Internet required for ~90MB embedding model download** the first time the backend boots. After that, RAG works fully offline. The app shows a yellow banner ("First run: downloading AI embedding model...") that auto-clears once `embedding_model_available` flips true.
- **Daily 02:00 RAG sync** fetches new IT Act / Rules sections from Indian Kanoon and (if enabled) probes incometaxindia.gov.in for new CBDT circulars/notifications.
- **Manual CBDT ingest**: drop PDFs into `%LOCALAPPDATA%\ITaxReplyAgent\rag\docs\` and either trigger sync from the **RAG Library** panel or wait for the next 02:00 cron.

---

## Indian Kanoon token

The Indian Kanoon REST API powers the IT Act / Rules / Finance Act auto-fetch path (Phase C of every sync). Get a free non-commercial token at <https://api.indiankanoon.org>. Free tier ships with **₹10,000/month** of credits — comfortably more than a daily sync needs.

Three ways to provision the token:

1. **At install time** — masked field on the NSIS Configuration page. Writes to `config.json` directly.
2. **In-app Settings** — masked "Indian Kanoon API token" field on the Settings panel. Saving restarts the backend so the new token takes effect immediately.
3. **Hand edit** — open `%LOCALAPPDATA%\ITaxReplyAgent\config.json` and set `"indiankanoon_token": "<your-token>"`.

Without a token the IK auto-fetch is disabled and the RAG library is built solely from your manual drop folder — still fully functional, just no automatic statute coverage.

---

## Supported file types (upload)

PDF, DOCX, XLS, XLSX, JPG, JPEG, PNG. Excel inputs are flattened to `Headers: …` / `Row N: …` with Indian-style number formatting and `DD/MM/YYYY` dates; the system prompt branches to "EXTRACTED FINANCIAL / COMPUTATION DATA" mode when it sees `# Sheet:` markers so the model treats the input as financial records rather than a notice body.

---

## Model auto-selection

The backend picks between `qwen2.5:14b` and `deepseek-r1:14b` per request:

- **Standard notice** (short text, no complex keywords) → `qwen2.5:14b` (faster, better structured output).
- **Complex notice** (Section 263, search/seizure, prosecution, transfer pricing, DTAA, reassessment under 148/153C, etc.) → `deepseek-r1:14b` (slower, better reasoning).
- **Insufficient resources** (< 10 GB free VRAM AND < 20 GB free RAM) → still attempts `qwen2.5:14b`, logs a warning. We never silently refuse.
- **Primary fails for any reason** → the candidate chain falls back to the other 14B model transparently.

The Dropdown in the UI overrides auto-selection — pin a specific model when you need reproducibility.

---

## Uninstall

Either:

- **Windows Settings → Apps → Income Tax Legal Reply Agent → Uninstall**, or
- run `C:\Program Files\ITaxReplyAgent\Uninstall *.exe` directly.

The uninstaller asks one question: **"Also delete all my data (sessions, replies, RAG documents)?"**

- **Unchecked (default)** — only the application files in `C:\Program Files\ITaxReplyAgent\` and the Desktop / Start Menu shortcuts are removed. Your `%LOCALAPPDATA%\ITaxReplyAgent\` tree (sessions, generated `.docx` replies, RAG index, `config.json`) is preserved. You can delete it manually later or leave it for the next install.
- **Checked** — the uninstaller pops a second `WARNING: this cannot be undone` confirmation, then recursively removes `%LOCALAPPDATA%\ITaxReplyAgent\`.

In both cases the uninstaller kills `backend.exe` and the Electron `.exe` before deleting the install directory (`taskkill /F /IM`), so in-use file locks don't block the cleanup.

**What the uninstaller does NOT touch:**

- Ollama itself (you installed it; you uninstall it via its own uninstaller in `%LOCALAPPDATA%\Programs\Ollama\`).
- Pulled models (`qwen2.5:14b`, `deepseek-r1:14b`) at your configured model storage path.
- Tesseract OCR.

---

## Reference library (RAG) — hybrid ingestion

The app retrieves relevant CBDT material at reply-generation time and prepends it to the model prompt as a "RELEVANT CBDT DOCUMENTS" block (so the model can cite real source material instead of hallucinating circular numbers). The reference library is built from two sources: a **manual drop folder** on disk, and the **Indian Kanoon REST API** which is hit automatically on every sync.

### Why two paths

We first tried direct scraping of `incometaxindia.gov.in`. That site is a React SPA behind Akamai bot management — every request from Chromium (headed or headless) is rejected at the edge with HTTP 403 before any JS runs. We pivoted to Indian Kanoon (`api.indiankanoon.org`) for the statutes (Income Tax Act / Rules / Finance Acts) and added an opt-in direct-PDF probe of `incometaxindia.gov.in/news/` for circulars and notifications. The manual drop folder remains for anything neither source carries.

### Indian Kanoon token setup

There are three ways to set the token; pick the one that fits your install method:

1. **NSIS installer (packaged):** the "Configuration" page has a masked "Indian Kanoon API Token" field. Leave blank to disable the API path entirely (manual ingest still works). The installer writes it to `%LOCALAPPDATA%\ITaxReplyAgent\config.json`.
2. **In-app Settings panel:** the masked "Indian Kanoon API token" field saves through `window.localAgent.saveConfig`, which restarts the backend so the new token takes effect.
3. **Hand edit:** open `config.json` (path printed in `backend.log` under `[itax.paths]`; defaults to `backend\config.json` in dev, `%LOCALAPPDATA%\ITaxReplyAgent\config.json` in a packaged install) and set `"indiankanoon_token": "<your-token>"`.

The source default is **blank** — never commit a real token. Get one from https://api.indiankanoon.org/ (the free tier covers sync usage).

The scraper runs ten queries per sync, five pages each, capped at 100 new documents per run with a 0.5-second per-call throttle.

### Manual drop folder

1. **Find the docs folder path.** It's printed on first boot in `backend.log`, exposed at `GET /rag/docs-folder`, and shown in the in-app `RagStatusPanel`. Default locations:
   - **Dev (running from source)**: `backend\rag\docs\`
   - **Packaged install**: `%LOCALAPPDATA%\ITaxReplyAgent\rag\docs\`

2. **Drop the files in.** Supported formats:
   - `.pdf` — primary; validated by `%PDF-` magic bytes.
   - `.docx` — validated by zip magic.
   - `.txt` — accepted by extension (used by the Indian Kanoon path; also fine for OCR transcripts).

3. **Name the files reasonably** so the doc-type classifier can label them. The filename stem is matched (case-insensitive) against `circular`, `notification`, `press_release`, `finance` / `income-tax-act`, `rule(s)`. Files that match nothing are tagged `unknown` — still indexed and searchable, just not filterable by type.

4. **Trigger sync** via either:
   - The `Sync now` button in the in-app `RagStatusPanel`, or
   - `POST /rag/sync` (the scheduled daily 02:00 sync also runs this automatically).

5. **Verify** in `RagStatusPanel`: `Documents indexed` goes up by the number of new files; `Chunks in vector store` goes up by the chunked text count. The full per-document list is at `GET /rag/documents`.

### What happens during sync

`scrape_all_sources()` runs four phases plus a one-time cleanup at the top:

0. **Cleanup pass.** `_cleanup_unrelated_chunks()` drops any chromadb chunks whose `document_title` contains "waqf" (case-insensitive). Idempotent; after the first run it's a no-op.
1. **Phase A — manual ingest.** Recursive scan of `RAG_DOCS_DIR`. Each new file (dedup keyed on `sha256(name|size|mtime)`) is validated by magic bytes, classified by filename, and queued for embedding.
2. **Phase B — incometaxindia.gov.in /news/ direct-PDF probe.** Gated by the `incometax_pdf_scraper_enabled` config flag (default `false`). For each `(year, doc_type)` in `{current, last} × {notification, circular}` the scraper HEAD-probes `/news/<doc_type>-no-<N>-<year>.pdf` for `N=1..50` (plus zero-padded variant for `N<10`), bails after 5 consecutive misses per combo, GETs the 200s, magic-byte-checks, saves under `RAG_DOCS_DIR/<doc_type>/`, and direct-ingests. Capped at 100 new docs per sync. Akamai may 403 from non-Indian IPs — the kill-switch keeps the rest of the sync running cleanly.
3. **Phase C — Indian Kanoon scrape.** Ten queries × five pages each with the inline `doctypes:laws` selector. Each row is filtered: `docsource` must start with `"Union of India"`, and the title must contain a direct-tax keyword (income tax / finance act / TDS / capital gains / etc.). For each survivor the scraper POSTs `/docmeta/<docid>/` and `/doc/<docid>/`, strips HTML, and writes a `.txt` file under `RAG_DOCS_DIR/<doc_type>/`. Capped at 100 new docs per sync.
4. **Phase D — rescan.** A second recursive pass over `RAG_DOCS_DIR` catches any file whose direct-ingest failed mid-flight in phases B or C.

Embedding (in all phases) is done by `services/rag_embedder.py`: text is paragraph-chunked at ~512 tokens with 50-token overlap, encoded locally with `sentence-transformers/all-MiniLM-L6-v2`, and upserted into ChromaDB with the document's `source_url`, `document_type`, `cbdt_ref`, `effective_date`, and supersession flags. The embedder dispatches on file extension (`.pdf` → pdfplumber, `.docx` → python-docx, `.txt` → UTF-8 read), so Indian Kanoon's plain-text saves are handled natively.

If you re-save a file, its mtime changes and it gets re-ingested. To force a full re-index, hit `POST /rag/reindex` (preferred), or delete `<basedir>/rag/sync_status.json` (the dedup state) and `<basedir>/rag/chromadb/` (the vector store) and trigger sync.

### First-run model download

The embedding model (`all-MiniLM-L6-v2`, ~90 MB) needs an internet connection on the very first sync. After that, all RAG processing is fully offline. The `RagStatusPanel` surfaces this with an "Embedding model not yet downloaded" banner; `GET /rag/status` exposes it as `embedding_model_available: false`.

### Wiring the panel into the UI

`RagStatusPanel.tsx` is shipped as additive code (same convention as `SettingsPanel`). Drop `<RagStatusPanel />` into your sidebar when you want it visible — it has no dependencies on `App.tsx` state.

---

## Manual Ollama fallback (if auto-install fails)

If the installer's Ollama download fails (corporate proxy, restrictive firewall, etc.):

1. Skip the Ollama step in the installer when prompted.
2. After install, manually:
   ```cmd
   :: download from https://ollama.com
   OllamaSetup.exe
   ollama pull qwen2.5:14b
   ollama pull deepseek-r1:14b
   ```
3. If you want models in a non-default location, set the system env var:
   ```cmd
   setx OLLAMA_MODELS "D:\models"
   ```
   then restart Ollama.

---

## Logs reference

All logs under `%LOCALAPPDATA%\ITaxReplyAgent\logs\`:

| File           | Source                                                |
|----------------|-------------------------------------------------------|
| `backend.log`  | FastAPI + uvicorn output (rotated, 5 MB × 3)          |
| `frontend.log` | Electron main process (spawn, IPC, lifecycle)         |
| `installer.log`| NSIS installer steps + errors (created during install)|

Open the logs folder from inside the app via the Settings panel's **View Logs** button.

---

## File-by-file map of what was added/changed for packaging

| File                                       | Why                                                                |
|--------------------------------------------|--------------------------------------------------------------------|
| `backend/paths.py`                         | `%LOCALAPPDATA%\ITaxReplyAgent` resolution, config, log rotation, tesseract bootstrap |
| `backend/main.py`                          | port fallback chain, `port.txt`, log/tesseract config              |
| `backend/services/session_store.py`        | `DATA_DIR` from `paths`                                            |
| `backend/services/docx_writer.py`          | `OUTPUT_DIR` from `paths`                                          |
| `backend/routes/upload.py`                 | `UPLOAD_DIR` from `paths`                                          |
| `backend.spec`                             | PyInstaller spec — hidden imports, Tesseract bundling              |
| `frontend/electron/main.ts`                | backend spawn, single-instance lock, dev/prod path switching, settings IPC |
| `frontend/electron/preload.ts`             | `window.localAgent` extended with `getConfig` / `saveConfig` / `openLogsFolder` |
| `frontend/package.json`                    | `electron-builder@25.1.8` pin + `build.*` config + `extraResources` |
| `frontend/src/components/SettingsPanel.tsx`| Additive Settings screen                                           |
| `installer/installer.nsh`                  | NSIS hooks: config page, disk check, Ollama, model pull            |
| `build.bat`                                | `%~dp0`-anchored 9-step build                                      |

`window.localAgent` is preserved exactly. The four original IPC channels (`open-output-folder`, `list-sessions`, `read-session`, `delete-session`) are unchanged — the Settings work uses additive channels only (`get-config`, `save-config`, `open-logs-folder`, `get-backend-port`).

---

## Troubleshooting

| Symptom                                                          | Fix                                                                                              |
|------------------------------------------------------------------|--------------------------------------------------------------------------------------------------|
| `[Step 1] ERROR: Tesseract OCR not found`                        | Install from https://github.com/UB-Mannheim/tesseract/wiki to `C:\Program Files\Tesseract-OCR`.  |
| Defender deletes `ITaxReplyAgent-Setup.exe` mid-install          | Add the exclusions per *Install on deploy machine → 1*.                                          |
| App launches but exits with "Backend failed to start"            | Open `%LOCALAPPDATA%\ITaxReplyAgent\logs\backend.log` — usually missing tessdata or port clash.  |
| Models pull is stuck / very slow                                 | `ollama pull` resumes; close + rerun installer or pull from a terminal manually.                  |
| `ollama list` shows the models but app says they're missing      | Backend can't reach Ollama. Check `%LOCALAPPDATA%\ITaxReplyAgent\config.json` for correct host/port. |
| App opens but sidebar is empty + "no sessions"                   | Expected on a fresh install. Generate a reply to seed the session list.                          |

---

## Local-only guarantees

- Backend binds `127.0.0.1` only.
- Electron main + renderer make no outbound calls except to `127.0.0.1:<backend_port>` and `127.0.0.1:<ollama_port>`.
- Crash reporter / telemetry disabled in Electron command line switches.
- All user data lives under `%LOCALAPPDATA%\ITaxReplyAgent\`. Nothing is written to the install dir at runtime (UAC).
- The installer is the only step that talks to the public internet — and only to `https://ollama.com/download/OllamaSetup.exe` and the Ollama model registry. Both are skippable.
