# Income Tax Legal Reply Agent Frontend

Electron + React frontend for the local FastAPI backend.

## Prerequisites

- Node.js 20+ (24.x tested)
- Backend running (see `../backend/README.md`)
- Ollama running locally with the required models

## Install

```powershell
cd frontend
npm install
```

## Run

Start the backend first:

```powershell
cd ..\backend
.\start.ps1
```

Then start the frontend:

```powershell
cd ..\frontend
.\start.bat
```

The frontend talks only to the local backend on `127.0.0.1`. It never
hardcodes a port: the Electron main process resolves the backend port at
startup and the renderer requests it over IPC (`get-backend-port`). The
backend takes the first free port in `8000–8003` and records it in
`port.txt`.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server + Electron, concurrently (alias: `npm start`) |
| `npm run typecheck` | `tsc --noEmit` for both renderer and Electron configs |
| `npm run build` | Typecheck, `vite build`, then compile Electron to `dist-electron/` |
| `npm run package` | `electron-builder --win --x64` → NSIS installer |
| `npm run package:dir` | Unpacked build, no installer — faster for testing |

Run `npm run typecheck` before packaging. `npm run build` typechecks too, but
`package` alone does not.

## Preload bridge

The renderer has no Node integration. Everything privileged goes through
`window.localAgent`, defined in `electron/preload.ts`.

**The `window.localAgent` shape and these IPC channel names are a stable
contract — add to them, but do not rename or remove.**

| Method | Channel | Purpose |
|---|---|---|
| `openOutputFolder(file)` | `open-output-folder` | Reveal a generated DOCX in Explorer |
| `listSessions()` | `list-sessions` | Enumerate saved drafting sessions |
| `readSession(id)` | `read-session` | Load one session's history |
| `deleteSession(id)` | `delete-session` | Delete a session file |
| `getConfig()` | `get-config` | Read `config.json` |
| `saveConfig(next)` | `save-config` | Write a partial config update |
| — | `open-logs-folder` | Reveal the log directory |
| — | `get-backend-port` | Resolved backend port |
| — | `get-backend-auth` | Per-install `X-ITax-Auth` token |
| — | `apply-desktop-settings` | Apply tray / startup / keep-awake settings |

`open-output-folder` validates the path against the output directory, and
picks that directory by `app.isPackaged` — dev output lives in
`backend/output`, installed output under `%LOCALAPPDATA%`. Use
`app.isPackaged`, never `NODE_ENV`, for this distinction.

`save-config` validates `rag_sync_schedule` as a cron expression before
writing. An invalid one is rejected with a message rather than silently
replaced, because a malformed schedule reaching the backend's import-time
scheduler would stop the backend from starting.

## Checks

```powershell
npm run typecheck
npm run build
```

## Upload Error Handling

The upload panel handles:

- `415`: `Unsupported file type`
- `413`: `File too large`
- empty extracted text: `Could not extract text from file`
- connection refused or network failure: `Backend not reachable`
- no response after 30 seconds: `Upload timed out`
- other backend errors: backend `detail`, or `Upload failed`

Errors appear inline below the drop zone and clear automatically when a new file is selected or dropped. Generate stays disabled while upload is errored or still uploading.

## Local-Only Notes

- No telemetry, analytics, tracking, or CDN assets are used.
- Electron does not start crash reporting.
- Renderer has no Node integration; the preload bridge is the only
  privileged surface (see [Preload bridge](#preload-bridge)).
- All HTTP traffic goes to `127.0.0.1` only.
- Mutating backend calls carry the `X-ITax-Auth` token, fetched once via
  `get-backend-auth`. Without it the backend answers `403` to any request
  arriving with a browser `Origin` it does not trust.

## License

GNU General Public License v3.0 — see [LICENSE](../LICENSE) at the
repository root.
