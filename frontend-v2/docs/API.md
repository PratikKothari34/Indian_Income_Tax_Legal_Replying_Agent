# Backend + IPC contract (frozen)

Read from the live backend source on 2026-10-12. **These names are frozen.**
Renaming a route, an IPC channel or a `window.localAgent` field breaks installed
clients that update the frontend and backend independently. Additions are fine.

Base URL is `http://127.0.0.1:<port>`. The port is **dynamic** — the backend
falls through 8000 → 8001 → 8002 → 8003 and writes the bound port to
`port.txt`. Always resolve it via `window.localAgent.getBackendPort()`, with
`8000` as the fallback when the preload bridge is absent (plain-browser dev).

## Auth — required for every mutating request

The backend rejects browser-originated `POST/PUT/PATCH/DELETE` from an
untrusted origin unless the request carries the per-install token:

```
X-ITax-Auth: <window.localAgent.getBackendAuth()>
```

The packaged renderer runs on the `file://` "null" origin, which is **not**
trusted, so the header is mandatory in production. Dev origins
(`127.0.0.1:5173` etc.) are trusted and work without it — meaning **a bug here
passes in dev and 403s only in the packaged build.** Attach it unconditionally.

`GET` requests never need it.

## HTTP routes

### `GET /health`
```ts
{
  status: "ok" | "degraded",
  ollama_running: boolean,         // see the naming note below
  primary_available: boolean,
  fallback_available: boolean,
  error: string | null,

  // v2 additions
  engine: "llama.cpp",
  base_url: string,                // "http://127.0.0.1:8090"
  loaded_model: string | null,     // what the server actually has in memory
  primary_model: string,           // the FILE STEM, e.g. "qwen2.5-3b-instruct"
  fallback_model: string,
  server_managed: boolean          // did this backend spawn llama-server
}
```

**`ollama_running` is kept under v1's name on purpose.** It now means "an
inference server is answering". Renaming it would break an installed frontend
that updates independently of the backend, which the API-surface rule forbids.

`status` is `"ok"` when the server answers **and** either a configured model
path exists on disk or the server already has a model loaded. That last clause
matters: a `llama-server` started by hand with its model on the command line
has no configured path and is still perfectly usable, so it must not read as
degraded. `status` gates the Draft button.

`primary_model` / `fallback_model` are **file stems, not paths** — a full
`.gguf` path is unreadable in a status line. Never send a stem back as a
`model` override; see `/generate`.

### `GET /models`
```ts
{
  primary: string,
  fallback: string,
  models: { name: string; size: number; modified_at: string; path: string }[],
  loaded: string | null
}
```
Infallible — it enumerates `.gguf` files on disk, so there is no 503 and no
unreachable case. `models` is a **wrapped object**, not a bare array.

**`path` is the field `/generate` accepts as a `model` override**, not `name`.
A bare stem silently falls through to the backend's configured primary.

### `POST /upload` — `multipart/form-data`, single field `file`
```ts
// 200
{ filename: string, saved_path: string, char_count: number, text: string }
```
`filename` is the name **actually written** — it differs from the uploaded name
when a collision was resolved to `notice (2).pdf`. Display this one.

Accepts `.pdf .docx .xlsx .xls .jpg .jpeg .png`. Limit **25 MiB**.
Errors: `400` empty/no filename · `413` too large · `415` unsupported type *or*
content not matching the extension · `500` parser crash. Error body is
`{ detail: string }`.

### `POST /generate`
```ts
// request
{
  text?: string,            // extracted notice text; "" allowed
  query?: string,           // user instruction; "" allowed
  model?: string | null,    // null = auto-select
  history?: { role: "user" | "assistant"; content: string }[],
  session_id?: string | null,  // null = start a new session
  temperature?: number,     // 0.0–1.0, default 0.2
  save_output?: boolean     // default FALSE — no .docx unless true
}
// 200
{
  reply: string,
  model_used: string,
  output_file: string | null,   // null when save_output was false
  session_id: string
}
```
- At least one of `text` / `query` must be non-blank, else `400`.
- `503` the inference server is unreachable or every candidate model failed ·
  `500` DOCX/session write failure.
- Body cap **10 MiB** → `413` (`middleware.rs`; `/upload` has its own 25 MiB cap).
- `temperature` outside 0.0–1.0 is a `400`.
- `session_id` must match `^[A-Za-z0-9_-]{1,64}$`. `model` is a **path**, and is
  rejected when it exceeds 512 chars, holds a NUL/CR/LF, starts `\\` or `//`
  (UNC), or contains a `..` segment. Both are **`400`**, not `422`, so validate
  client-side before sending.
- **Not streaming.** It is a single blocking JSON response that can take
  minutes. The draft-stream animation is a client-side reveal of text already
  received, not SSE.
- `save_output: false` is the default. **Do not re-request `/generate` with
  `save_output: true` to save a draft already on screen** — that re-runs the
  model for minutes and returns a *different* reply, which then replaces the
  one the user has been reading, on a button labelled "Save". Use
  `/save-docx`. `save_output: true` on `/generate` is for the case where the
  user asked for a file up front, before the draft exists.

### `POST /save-docx`
```ts
// request
{ reply: string }            // the reply text as the user has it on screen
// 200
{ output_file: string }      // absolute path of the .docx written
```
Writes a Word file and nothing else: no inference, no session write, no
history. Returns in milliseconds.

- A blank or whitespace-only `reply` is a **`400`** (`"There is no reply to
  save."`); an empty file in `output/` looks like a failed draft the user has
  to clean up.
- A write failure is a **`500`** (`"The Word file could not be written."`).
  The real cause goes to the log, not the response.
- The text travels in the body rather than being looked up by `session_id`,
  so an **edited** draft saves what is on screen rather than what the model
  last returned.
- Shares `/generate`'s **10 MiB** body cap — its body is a whole reply.
- **An addition, never a rename.** An installed frontend that predates this
  route keeps working against `/generate`.

### RAG
- `GET /rag/status` → `{ last_sync, last_sync_status, next_scheduled_sync, embedding_model_available, chunks_total, superseded_docs, ... }`.
  When `embedding_model_available === false` and `last_sync_status === "never"`,
  show: *"Run sync once with internet to download the embedding model."*
- `POST /rag/sync` → `{ status: "started", message }`. Fire-and-forget; poll
  `/rag/status`.
- `GET /rag/documents` → a **bare array** of indexed documents with chunk counts
  and supersession flags.
- `POST /rag/reindex` → `{ status: "started", message }`. **Destructive** — wipes
  the vector store and re-embeds. Must be confirmed in the UI.
- `GET /rag/docs-folder` → `{ path: string, exists: boolean }` — the manual
  drop folder.

## Host bridge — `window.localAgent` (field names frozen)

**v2 is Tauri, not Electron.** The ten channels below were Node code in
`frontend/electron/main.ts`; in v2 they are **Rust commands** in
`src-tauri/src/`. The renderer-facing shape is deliberately unchanged — the
frozen contract is the *names*, not the transport.

`src/lib/bridge.ts` builds `window.localAgent` over Tauri `invoke()`, so every
component keeps calling `window.localAgent?.listSessions?.()` exactly as before.

| `window.localAgent` method | Tauri command | Returns |
|---|---|---|
| `openOutputFolder(outputFile)` | `open_output_folder` | `{ ok: boolean; error?: string }` |
| `listSessions()` | `list_sessions` | `{ session_id, created_at, updated_at, turn_count }[]` newest first |
| `readSession(sessionId)` | `read_session` | `StoredSession` — **rejects** an invalid id |
| `deleteSession(sessionId)` | `delete_session` | `{ success: boolean; error?: string }` |
| `getConfig()` | `get_config` | `Config` with `indiankanoon_token` **masked** |
| `saveConfig(next)` | `save_config` | `{ success, error?, backend_port?, config? }` |
| `openLogsFolder()` | `open_logs_folder` | `{ ok: boolean; error?: string }` |
| `getBackendPort()` | `get_backend_port` | `number` |
| `getBackendAuth()` | `get_backend_auth` | `string` — `""` before the backend boots |
| `applyDesktopSettings(s)` | `apply_desktop_settings` | `{ success: boolean; error?: string }` |

`AppConfig` — the real key set, from `src-tauri/src/config.rs`. There are no
`ollama_*` keys: v2 runs llama.cpp.

```ts
{
  // inference
  llama_host: string, llama_port: number,
  llama_server_path: string,            // "" means "already running"
  llama_model_path: string,             // absolute path to a .gguf
  llama_fallback_model_path: string,
  llama_ctx_size: number, llama_gpu_layers: number,

  // server
  backend_port: number,                 // MUST be one of 8000-8003, see below

  // corpus
  indiankanoon_token: string,           // ALWAYS MASKED across the bridge
  incometax_pdf_scraper_enabled: boolean,  // persisted; not implemented
  rag_sync_schedule: string,            // cron, e.g. "0 12 * * *"

  // windows
  run_at_startup: boolean,
  system_tray: boolean,                 // persisted; NOT implemented
  keep_awake: boolean,                  // persisted; NOT implemented

  // drafting preferences (host-only: backend takes both per request)
  default_temperature: number,          // 0..1
  always_save_docx: boolean
}
```

**`save_config` is a patch, not a replacement.** Every key is
`unwrap_or(current)` on the host, so a key the renderer omits keeps its stored
value. That is what lets the Settings panel offer a subset of the keys without
erasing the rest.

### `backend_port` is not a free choice

The renderer reaches the backend over `fetch`, which the Tauri CSP gates.
`connect-src` in `tauri.conf.json` allows exactly `127.0.0.1:8000`-`8003`,
matching `backend::PORT_FALLBACK_CHAIN`. A backend moved outside that set
starts and answers normally while the renderer is permanently blocked from
reaching it — including the Settings panel that would put it back, leaving
hand-editing `config.json` as the only recovery.

`save_config` therefore rejects any other port, and the Settings panel does
not offer the field. `backend::tests::the_csp_allows_every_port_in_the_fallback_chain_and_no_others`
reads the real `tauri.conf.json` and fails if the two ever drift.

### Three switches are persisted but do nothing

`system_tray`, `keep_awake` and `incometax_pdf_scraper_enabled` round-trip
through the config and are **not implemented**: no tray icon is constructed,
nothing calls `SetThreadExecutionState`, and enabling the PDF probe only
pushes an explanatory error into the sync report. The Settings panel does not
offer any of them. The keys stay on the type because the host still stores
them, so re-adding the UI once the behaviour exists is a small change.

Every call must be optional-chained (`window.localAgent?.x?.()`) — the bridge is
absent in plain-browser dev (`npm run dev:web`) and the UI must still render.

### The token mask — do not break this

`get_config` never returns the real Indian Kanoon token. It returns
`maskToken(t)`: `""` when unset, `"********"` when 8 chars or shorter, else
`first4 + "****" + last4`.

`save_config` compares an incoming `indiankanoon_token` against
`maskToken(stored)`. **If they are equal, the user did not edit the field, and
the real stored token is kept.** Without that check, any settings save — even
flipping "Open when I sign in" — would overwrite the live token with the mask
and destroy it.

The renderer therefore:
- renders the masked value as-is,
- sends it back untouched when the user did not edit it,
- never logs it, never puts it in an error message, never echoes it to console.

### Host-side rules the Rust commands must preserve

- **`open_output_folder` validates containment.** The resolved folder must equal
  the base dir or sit under `base + separator`; the separator suffix is what
  stops a sibling-prefix bypass (`...\ITaxReplyAgent_evil`). An out-of-tree path
  falls back to opening the output dir, and is logged.
- **`read_session` / `delete_session` validate the id** against
  `^[A-Za-z0-9_-]{1,64}$` before touching the filesystem.
- **`list_sessions` is per-file fault-tolerant** — one corrupt session JSON must
  not blank the sidebar; skip it and return the rest.
- **`save_config` validates** before writing: `backend_port` is one of
  `PORT_FALLBACK_CHAIN` (see above), `llama_port` is an integer in 1024–65535
  and differs from `backend_port`, `default_temperature` is finite and in
  0–1 (finite checked first: NaN fails every comparison and would slip through
  a bare range test), and `rag_sync_schedule` is a 5-field cron. Then it
  restarts the backend so the new config takes effect.
- **Dev vs production paths switch on whether the build is packaged**, never on
  an env var. Dev reads `backend/data`, `backend/output`,
  `backend/auth_token.txt`; production reads the AppData tree.

### AppData layout — must match `backend/paths.py` exactly

```
%LOCALAPPDATA%\ITaxReplyAgent\
    config.json      port.txt      auth_token.txt
    data\   output\   uploads\   logs\
    rag\{docs,chromadb,models}\
```

Created eagerly at startup in production so the first backend boot finds a
present tree.

### Backend lifecycle — port this carefully

- Production owns the backend: spawn the bundled `backend.exe`, then poll
  `GET /health` until it answers.
- **The timeout is 120 s, not 30 s.** `backend.exe` is a ~354 MB PyInstaller
  onefile; the bootloader unpacks and re-execs before uvicorn starts, so a warm
  cold-start is ~23 s and the first post-install launch is slower (Defender
  scans the new exe). A 30 s budget produced false "Backend failed to start"
  against a backend that came up fine seconds later.
- Read `port.txt` on every poll — the backend falls through 8000→8003 and
  writes the port it actually bound.
- Spawn with `HF_HOME`, `TRANSFORMERS_CACHE` and `SENTENCE_TRANSFORMERS_HOME`
  all pinned to `rag\models`, plus `HF_HUB_DISABLE_TELEMETRY=1`, so
  sentence-transformers never writes to `%USERPROFILE%\.cache`.
- **Dev never spawns anything.** Poll for 30 s, then surface
  *"Backend not running. Start it with: cd backend && python main.py"*.

## Session file shape

```ts
StoredSession = {
  session_id: string, created_at: string, updated_at: string,
  turns: {
    timestamp: string, model: string,
    notice_text: string, query: string, reply: string,
    output_file: string            // "" when nothing was saved
  }[]
}
```
Append-only. To rebuild chat history for `/generate`, flatten each turn into
`{role:"user", content: query}` + `{role:"assistant", content: reply}`.
