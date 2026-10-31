# Building and verifying

Two app stacks share one install directory. Every shipped artifact is
compiled, so **source and binary drift silently** — the rules below are what
catches it.

## The four packaged artifacts

| Artifact | Built from | Drifts when |
|---|---|---|
| `dist-backend/backend.exe` | `backend/` (PyInstaller onefile) | `backend/` edited without a rebuild |
| `frontend/dist/` → `app.asar` | `frontend/` (Vite, embedded at package time) | `frontend/src/` edited without a repackage |
| `frontend-v2/src-tauri/target/release/itax-reply-agent.exe` | `frontend-v2/` renderer, **embedded at `cargo build` time** | `vite build` did not run first |
| `frontend-v2/src-tauri/target/release/backend-rs.exe` | a **copy** of `backend-rs/target/release/backend-rs.exe` | the backend was rebuilt and not re-copied |

Two ordering rules follow from that table:

1. **`vite build` must run BEFORE `cargo build --release`.** A launch that
   races the dist build runs a stale bundle, and the screenshot lies.
2. **Re-copy `backend-rs.exe` into the sidecar path after every backend
   rebuild**, or the app runs the old backend while the tests pass against
   the new one.

## Test suites

| Suite | Command | Count |
|---|---|---|
| Backend v1 | `pytest` under `backend/.venv` | 164 |
| Backend v2 | `cargo test --release` in `backend-rs/` | 153 |
| Frontend v1 | `npm run typecheck` in `frontend/` | — |
| Frontend v2 | `npx tsc --noEmit` in `frontend-v2/` | — |

`ITAX_BASE_DIR_OVERRIDE` must be set before import for the Python suite; it
is what keeps a test run from overwriting the live config.

## Verifying the running app

- **Screenshots work. Input injection does not.** Don't conflate them.
  - Capture with `PrintWindow` + `PW_RENDERFULLCONTENT` (0x2). A plain
    `BitBlt` of a DWM-composited window returns black for the WebView2
    surface; that flag is the fix. Reusable script:
    `frontend-v2/docs/capture-window.py`.
  - `SendInput` returns 1 with `GetLastError` 6; the coordinate resolves to
    `Chrome_RenderWidgetHostHWND`. **No control in the v2 UI has been
    pressed by anything but a human.**
- **Drive the backend directly to verify behaviour.**
  `frontend-v2/docs/e2e-smoke.py` exercises the real routes the UI calls, on
  the live port, with the real token — health, models, auth enforcement, RAG
  status, and a full `/generate`. It found an authentication bypass that code
  review and 153 passing tests had missed.
- **Allow ~18s after launch** before capturing, or the shot catches the
  "Starting" state.
- **`tsc` cannot see any of this class of bug.** A bridge race, an auth
  bypass and a run-together metadata row all typechecked clean. Run it, look
  at it.

## Testing rules that earned their place here

- **Logic that must be tested lives in a module, not in a route, handler or
  entry point.** Logic left inside one cannot be tested without booting the
  framework around it, so it does not get tested — which is how a bug
  survives a suite that looks thorough.
- **Test the function that DECIDES, not the one that reports.** Feeding a
  hand-built input to a presenter proves what the screen says once the answer
  is known; it cannot prove how the answer was computed, and the computation
  is the guard. If a guard reads stored state or accumulates across runs, the
  test must drive the real entry point across those runs — mock the data
  source, use real storage, assert on the second and third call.
  **This project paid for that rule:** every test of the request guard
  asserted over the origin *lists*, and all the lists were correct. The code
  consulting them was not — a mutation with no `Origin` header skipped
  authentication entirely. A list-shaped assertion cannot see that class of
  bug.
- **Redundant guards cannot be mutation-killed individually, and that is not
  a reason to delete one.** Two protections of the same invariant each mask
  the other, so every single-mutant run reports both as surviving; removing
  **both** is what fails the tests. Confirm genuine redundancy by mutating
  both at once, then say so in the PR — otherwise the next pass reads a
  surviving mutant as dead code and drops a real guard.
