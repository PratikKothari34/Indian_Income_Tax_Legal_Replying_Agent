# Income Tax Legal Reply Agent Frontend

Electron + React frontend for the local FastAPI backend.

## Prerequisites

- Node.js 20+
- Backend already running at `http://127.0.0.1:8000`
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

The frontend talks only to `http://127.0.0.1:8000`.

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
- Renderer has no Node integration.
- The preload bridge exposes only local output-folder opening and local session JSON reads.
