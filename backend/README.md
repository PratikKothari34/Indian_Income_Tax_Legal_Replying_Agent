# Indian Income Tax Legal Replying Agent — Backend

A fully-local FastAPI backend that drafts formal replies to Income Tax
notices issued under the Income Tax Act, 1961. Uses Ollama for inference,
runs only on `127.0.0.1`, and never makes outbound network calls.

The backend is consumed by an Electron frontend on the same machine.

---

## Contents

1. [Architecture](#architecture)
2. [Filesystem layout](#filesystem-layout)
3. [Setup](#setup)
4. [Running](#running)
5. [API reference](#api-reference)
6. [Legal-drafting prompt design](#legal-drafting-prompt-design)
7. [Local-only guarantees](#local-only-guarantees)
8. [Testing](#testing)
9. [Troubleshooting](#troubleshooting)
10. [Deployment notes](#deployment-notes)

---

## Architecture

```
┌──────────────────┐  HTTP (127.0.0.1:8000)   ┌──────────────────────┐
│ Electron frontend│ ───────────────────────► │ FastAPI (uvicorn)    │
└──────────────────┘                          │  ─ /health           │
                                              │  ─ /models           │
                                              │  ─ /upload           │
                                              │  ─ /generate         │
                                              └──────────┬───────────┘
                                                         │
                            ┌────────────────────────────┼─────────────────────────────┐
                            ▼                            ▼                             ▼
                ┌────────────────────┐  ┌────────────────────────────┐  ┌──────────────────────┐
                │ services/parser    │  │ services/ollama_client     │  │ services/docx_writer │
                │ (PDF/DOCX/XLS/OCR) │  │ (qwen2.5 → deepseek-r1)    │  │ (Markdown → DOCX)    │
                └────────────────────┘  └─────────────┬──────────────┘  └──────────────────────┘
                                                      │
                                                      ▼ HTTP (127.0.0.1:11434)
                                              ┌────────────────┐
                                              │ Ollama daemon  │
                                              └────────────────┘
```

Request flow for a single legal-reply turn:

1. Frontend `POST /upload` with the notice file → backend parses, persists raw
   under `uploads/`, returns extracted text.
2. Frontend `POST /generate` with `{ text, query, history?, session_id? }` →
   backend builds the chat-message array from `services/prompts.py`, calls
   Ollama (primary `qwen2.5:14b`, fallback `deepseek-r1:14b`), saves the reply
   as `output/ITax_Reply_<ts>.docx`, appends the turn to `data/session_<id>.json`,
   returns reply text + DOCX path + session id.

---

## Filesystem layout

```
backend/
├── main.py                      # FastAPI entrypoint, CORS, route wiring
├── requirements.txt             # pinned dependencies
├── start.ps1                    # PowerShell launcher (venv + install + uvicorn)
├── routes/
│   ├── health.py                # GET  /health
│   ├── models.py                # GET  /models
│   ├── upload.py                # POST /upload
│   └── generate.py              # POST /generate
├── services/
│   ├── parser.py                # PDF/DOCX/XLS/XLSX/JPEG → plain text
│   ├── ollama_client.py         # chat() with primary/fallback model chain
│   ├── prompts.py               # system prompt + chat-message builder
│   ├── docx_writer.py           # Markdown-aware .docx renderer
│   └── session_store.py         # JSON-on-disk per-session history
├── tests/
│   └── test_dummy_notice.py     # E2E test against a running backend
├── data/                        # session JSONs (created at runtime)
├── output/                      # generated DOCX replies (created at runtime)
└── uploads/                     # raw uploaded notices (created at runtime)
```

---

## Setup

### Prerequisites

| Software             | Why                                                         |
|----------------------|-------------------------------------------------------------|
| Python 3.11+         | FastAPI / pydantic / typing syntax (`str \| None`)          |
| [Ollama](https://ollama.com) | Local LLM runtime                                |
| Tesseract OCR        | Only if you need to process JPEG/PNG notices                |

### Install Python dependencies

The included PowerShell script does it for you (creates `.venv`, installs):

```powershell
cd backend
.\start.ps1                                    # one-shot: venv + install + run
```

Or manually:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### Pull the spec'd Ollama models

```powershell
ollama pull qwen2.5:14b      # primary
ollama pull deepseek-r1:14b  # fallback
ollama list                  # verify both are present
```

`qwen2.5:14b` is ~9 GB. On machines with <16 GB total VRAM+RAM, the model
will swap to disk and the first generation will be slow; on the spec'd 32 GB
target machine it loads fully into RAM.

### Tesseract (only if you process images)

Install from the [official Tesseract Windows build](https://github.com/UB-Mannheim/tesseract/wiki).
If the binary isn't on `PATH`, point `pytesseract` at it before calling `/upload`:

```python
import pytesseract
pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
```

(Set this once at the top of `services/parser.py` if you want it to persist.)

---

## Running

In one PowerShell window:

```powershell
ollama serve                                    # listens on 127.0.0.1:11434
```

In another:

```powershell
cd backend
.\start.ps1                                     # listens on 127.0.0.1:8000
```

Sanity-check from a third window:

```powershell
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/models
```

---

## API reference

All endpoints are JSON in / JSON out except `/upload` (multipart form-data
in, JSON out). The base URL is `http://127.0.0.1:8000`.

### `GET /health`

Backend liveness + Ollama readiness probe.

**Response**

```json
{
  "status": "ok",
  "ollama_running": true,
  "primary_model": "qwen2.5:14b",
  "primary_available": true,
  "fallback_model": "deepseek-r1:14b",
  "fallback_available": true,
  "models": ["qwen2.5:14b", "deepseek-r1:14b"],
  "error": null
}
```

`status` is `"ok"` only when Ollama is reachable AND at least one of the
primary/fallback models is pulled locally; otherwise `"degraded"`.

---

### `GET /models`

List all locally pulled Ollama models, with the backend's primary/fallback choice.

**Response**

```json
{
  "primary": "qwen2.5:14b",
  "fallback": "deepseek-r1:14b",
  "models": [
    {"name": "qwen2.5:14b",     "size": 9000000000, "modified_at": "..."},
    {"name": "deepseek-r1:14b", "size": 9000000000, "modified_at": "..."}
  ]
}
```

Returns HTTP `503` if Ollama is unreachable.

---

### `POST /upload`

Accept a notice file, persist it under `uploads/`, return extracted text.

**Request** — `multipart/form-data` with one field, `file`.

| Extension       | Parser                          |
|-----------------|---------------------------------|
| `.pdf`          | `pdfplumber` (text layer only)  |
| `.docx`         | `python-docx`                   |
| `.xlsx`         | `openpyxl` (read-only)          |
| `.xls`          | `xlrd 2.0.1`                    |
| `.jpg`/`.jpeg`/`.png` | `pytesseract` + Pillow OCR |

**Response**

```json
{
  "filename":   "notice.pdf",
  "saved_path": "C:\\...\\backend\\uploads\\notice.pdf",
  "char_count": 4321,
  "text":       "INCOME TAX DEPARTMENT\nOffice of..."
}
```

**HTTP errors**

| Code | Cause                                                |
|------|------------------------------------------------------|
| 400  | missing filename / empty body                        |
| 415  | unsupported extension                                |
| 500  | parser crashed (corrupt file, missing Tesseract bin) |

---

### `POST /generate`

Draft a legal reply, save it as `.docx`, append to session history.

**Request body**

```json
{
  "text":        "<extracted notice text>",
  "query":       "<user instruction>",
  "model":       "qwen2.5:14b",
  "history":     [
    {"role": "user",      "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "session_id":  null,
  "temperature": 0.2
}
```

| Field         | Required | Notes                                                  |
|---------------|----------|--------------------------------------------------------|
| `text`        | one of   | extracted notice text from `/upload`                   |
| `query`       | one of   | user's free-form instruction                           |
| `model`       | no       | override; otherwise uses primary/fallback chain        |
| `history`     | no       | prior turns of this session, oldest first              |
| `session_id`  | no       | `null` to start a new session; echo back to continue   |
| `temperature` | no       | 0.0–1.0; default 0.2 (low for legal precision)         |

At least one of `text` or `query` must be non-empty.

**Response**

```json
{
  "reply":       "To,\nThe Assessing Officer,...",
  "model_used":  "qwen2.5:14b",
  "output_file": "C:\\...\\backend\\output\\ITax_Reply_20260503_161046.docx",
  "session_id":  "6c808ed490ee"
}
```

The DOCX has Markdown emphasis converted to real bold / italic runs and
list bullets (see `services/docx_writer.py`). The reply text in the JSON
response retains its original Markdown so the frontend can render it as
desired.

**HTTP errors**

| Code | Cause                                                                       |
|------|-----------------------------------------------------------------------------|
| 400  | both `text` and `query` empty                                               |
| 503  | Ollama unreachable, or every candidate model failed                         |
| 500  | DOCX write or session-store failure                                         |

**Model fallback chain**: `model` (if given) → `qwen2.5:14b` → `deepseek-r1:14b`.
The first that is locally pulled AND returns non-empty content wins.
`model_used` in the response tells you which one actually answered.

---

## Legal-drafting prompt design

The system prompt is in `services/prompts.py` and is layered into four blocks:

1. **Jurisdiction & applicable law** — pins the model to Indian tax law, lists
   the authoritative sources (IT Act 1961, IT Rules 1962, Finance Act, CBDT
   Circulars / Notifications / Instructions).
2. **Sanity-check the notice** — instructs the model to challenge the AO's
   premise rather than parrot it. Includes a list of common section confusions
   (s.194-I vs s.194-IB, s.147/148/148A, s.270A vs s.271(1)(c), etc.).
3. **Drafting requirements** — the strict-failure anti-fabrication rule:
   a citation must satisfy *(a)* certain the instrument exists, *(b)* certain
   of number+year+date, *(c)* certain it is on point — else omit and flag for
   the assessee to verify on `incometaxindia.gov.in`. Plus citation format
   templates and the formal-letter tone requirement.
4. **Verified citation anchors** — a small whitelist of high-frequency correct
   citations the model can lean on without inventing:

   | Topic                                | Verified anchor                                       |
   |--------------------------------------|-------------------------------------------------------|
   | DIN on departmental communications   | CBDT Circular No. 19/2019 dated 14.08.2019            |
   | HRA / landlord-PAN (rent > ₹1 lakh)  | CBDT Circular No. 8/2013 dated 10.10.2013             |
   | Faceless assessment scheme           | Section 144B                                          |
   | s.194-I (TDS on rent, non-individual) | Section 194-I + Rule 30(1) + Rule 31A; Form 26Q       |
   | s.194-IB (rent, individuals/HUFs)    | Section 194-IB + Rule 30(2B) + Rule 31A(4A); Form 26QC |
   | s.195 (TDS to non-residents)         | Section 195 + Rule 37BB; Form 15CA / 15CB             |
   | Foreign tax credit                   | Rule 128; Form 67                                     |
   | Disallowance u/s 14A                 | Rule 8D                                               |
   | Valuation of unquoted shares u/s 56(2)| Rule 11UA                                            |
   | Reassessment regime (post FA 2021)   | Section 148A(b) / 148A(d) read with Section 149       |
   | SC precedent on new reassessment     | *Union of India v. Ashish Agarwal*, (2022) 444 ITR 1  |

**Tuning rule of thumb**: if the model starts hallucinating again, sharpen
the strict-failure block in `services/prompts.py` rather than adding post-hoc
filters. If a new high-frequency citation is needed, add it to the verified
anchors list — that is the cheap, reliable way to expand coverage.

---

## Local-only guarantees

* `main.py` binds uvicorn to `127.0.0.1` only — never `0.0.0.0`.
* `services/ollama_client.py` calls only the local Ollama daemon at
  `127.0.0.1:11434`.
* No outbound HTTP client is configured anywhere in the codebase. The only
  network library imported (`httpx`, transitively via `ollama`) is used
  only against the local daemon.
* All artefacts stay on disk under `backend/data/` and `backend/output/`.
  Nothing is uploaded to any cloud service.
* CORS is restricted to `localhost`, `127.0.0.1`, and the `null` origin
  (which is what `file://` Electron sends for packaged apps).

---

## Testing

The end-to-end smoke test in `tests/test_dummy_notice.py` exercises the full
`/health` → `/models` → `/generate` chain against a running backend. It uses
a hand-crafted s.142(1) notice that triggers three pitfalls:

1. **Premise check** — the notice cites s.194-IB but the tenant is a Pvt Ltd
   company, so the correct provision is s.194-I. The model must catch this
   in its preliminary submissions.
2. **Verified citation** — the HRA / landlord-PAN para must cite
   *CBDT Circular No. 8/2013 dated 10.10.2013* (the verified anchor). A
   previous run hallucinated *Circular 9/2023 dated 05/07/2023*; the test
   asserts that hallucination is gone.
3. **No fabricated rule** — the model must not invent *Rule 37A* for
   s.194-IB (the correct rule is 30(2B)); a previous run did. The test
   asserts that hallucination is gone too.

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python tests\test_dummy_notice.py
```

The test prints PASS/FAIL per criterion and the first 800 characters of the
reply. Notification absence is informational only — the strict-failure rule
prefers omission over invention.

---

## Troubleshooting

| Symptom                                                       | Likely cause / fix                                                                                                                              |
|---------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| `WinError 10061 ... target machine actively refused it`       | Backend isn't running (or crashed). Run `.\start.ps1`. If the test uses `localhost` and uvicorn is bound to IPv4, switch to `127.0.0.1`.        |
| `/health` returns `degraded` with `ollama_running: false`     | Ollama daemon isn't running. Start it with `ollama serve`.                                                                                      |
| `/health` returns `degraded` but `ollama_running: true`       | Neither primary nor fallback model is pulled. Run `ollama pull qwen2.5:14b` and `ollama pull deepseek-r1:14b`.                                  |
| First `/generate` call takes 1–3 minutes                      | Cold model load. With <16 GB combined VRAM+RAM, the model also spills to disk. Subsequent calls are fast while the model is hot.                 |
| Generation falls back to `deepseek-r1:14b` even though primary is pulled | Likely VRAM pressure on a small GPU (e.g., 8 GB laptop card) — primary chat call timed out / errored, fallback took over. This is the spec'd resilience working. On the 32 GB target machine, primary will hold. |
| DOCX shows literal `**foo**` text                             | Already fixed — `services/docx_writer.py` strips Markdown emphasis. Regenerate the reply if you saw this on an older run.                       |
| `Failed to parse file: tesseract is not installed`            | Install Tesseract OCR and ensure it is on `PATH`, or set `pytesseract.pytesseract.tesseract_cmd` in `services/parser.py`.                       |
| Pydantic warning about `model_used` and protected namespace   | Already fixed via `model_config = ConfigDict(protected_namespaces=())` in `routes/generate.py`.                                                  |

---

## Deployment notes

For the eventual 32 GB RAM target machine:

* No code changes needed — `qwen2.5:14b` will load fully in RAM and the
  fallback path effectively becomes unused (still kept as insurance).
* Move the working directory anywhere; all paths in the codebase are derived
  from `__file__` and stay relative to the `backend/` folder.
* If you bundle the backend into the Electron installer, ship `backend/` and
  invoke `python main.py` as a child process from the Electron main process.
  Don't forget to also bundle (or check for) Ollama and the pulled models —
  those live under `%USERPROFILE%\.ollama\models` by default.
* The packaged Electron app loads pages from `file://`, which means the
  browser sends `Origin: null`. The CORS list in `main.py` already allows
  `"null"` for this reason.

---

## License

Internal / private — not for redistribution.
