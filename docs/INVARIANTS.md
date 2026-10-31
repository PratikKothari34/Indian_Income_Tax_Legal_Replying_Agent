# Invariants

Things that must not change. Breaking one destroys an installed user's data,
leaks a credential, or breaks a client that updates independently.

Line numbers verified **2026-10-31**. They drift silently — re-verify when
you add a row or run an audit pass.

## Secrets

| Rule | Where | Why |
|---|---|---|
| `indiankanoon_token` stays `""` in source | `backend/paths.py:102` | A real token committed here is public permanently. Injected at runtime only by the installer, the Settings panel, or a hand edit. |
| Never read, edit, print or commit the config file | `backend/paths.py:67` | It holds a **live** Indian Kanoon token in a working tree. Excluded from git. Printing it leaks it into a transcript or log. |
| Never read, edit, print or commit the auth-token file | `backend/paths.py:69`, `backend-rs/src/paths.rs:100` | Per-install `X-ITax-Auth` bearer token, **shared by v1 and v2**. Leaking it lets any local process drive either backend. Read it into a variable if a test needs it; never into output. |
| Secrets are **reported, never auto-fixed** | anywhere | A rotation nobody initiated breaks the running install and can destroy the only copy of a credential. |

A leak is the one unrecoverable class. The remote is public: anything pushed
is world-readable and **stays in the history even after a later commit
deletes it.** A push cannot be taken back.

## Installed-user data

| Rule | Where | Why |
|---|---|---|
| `COLLECTION_NAME = "cbdt_documents"` must never be renamed | `backend/services/rag_embedder.py:44` | Renaming orphans every embedded vector in an installed user's ChromaDB. Re-embedding the corpus is a rebuild they did not ask for. |
| `BASE_DIR` layout must never be re-pointed | `backend/paths.py:62`, `backend-rs/src/paths.rs:39` | `~/AppData/Local/ITaxReplyAgent` on a packaged install, shared by v1 and v2. Changing it orphans every session, output, upload and vector of an existing install. |
| Tests must never run against the real `BASE_DIR` | `backend/paths.py:50` | `ITAX_BASE_DIR_OVERRIDE` must be set before import. Without it a test run overwrites the live config — and the live token with it. |

## Request authentication

| Rule | Where |
|---|---|
| A mutation must never reach a handler unauthenticated | `backend-rs/src/middleware.rs:189` |

The token check once sat inside `if let Some(origin)`, so a POST with **no
`Origin` header** skipped authentication entirely and ran real inference.
curl, PowerShell and every non-browser caller omit `Origin` by default;
browsers always send it cross-origin. An absent origin is not a trusted
origin — it must present a token like any other untrusted caller.

See `docs/BUILD-AND-VERIFY.md` for why the existing tests could not see this.

## The five config-default copies

Whichever process writes its config first decides what a fresh install gets.
A key added or changed in one must be changed in all five:

- `backend/paths.py` — v1 `DEFAULT_CONFIG`
- `frontend/electron/main.ts` — v1 Electron host
- `backend-rs/src/config.rs` — v2 backend
- `frontend-v2/src-tauri/src/config.rs` — v2 host
- `installer/installer.nsh` — writes the config file directly
  (`backend_port`, `indiankanoon_token`)

v1 and v2 keep **separate** config and port files inside one shared
`BASE_DIR`: `config.json`/`port.txt` versus `config-rs.json`/`port-rs.txt`.
They share the auth-token file deliberately — one token per install, and
rotating it breaks whichever half is running.

## The public surface

Never rename or remove an existing HTTP route, an IPC channel name, a field
on `window.localAgent` (`frontend/electron/preload.ts`,
`frontend-v2/src/lib/bridge.ts`), or a Tauri command name. **Additions are
fine**; renames break installed clients that update the frontend and backend
independently.

`backend-rs` route paths mirror v1's exactly, by design — `/rag/query` is the
only addition.

## Privacy wording

Inference is local, but the app makes outbound calls to three hosts: the
Indian Kanoon API, incometaxindia.gov.in, and the sentence-transformers model
download. **Never write "fully local" or "fully offline"** in the README,
docs, release notes or UI copy.

## LLM-backed code

This project runs llama.cpp locally with CUDA (`backend-rs`) and Ollama
(`backend/`, v1). These are design rules enforced while the code is written,
not findings to be discovered later.

- **The model's output is untrusted input.** Treat every token exactly like a
  POST body from the internet. Never into a shell, `eval`, a file path, SQL,
  or a tool-dispatch table without an explicit allowlist. A filename or path
  the model produced is a claim, not a value — validate at the boundary.
  `backend-rs/src/paths.rs` does this with `is_within`, a real path check and
  not a string prefix test.
- **Untrusted text reaching the prompt is the other half.** The uploaded
  notice, a RAG chunk, a scraped page — anything the user did not type — can
  carry instructions. The model cannot tell data from directive, so the
  **caller** draws that line. A prompt-sandbox forgery has already been fixed
  once here.
- **Weights are pinned and verified.** Record the SHA256 and provenance of
  every checkpoint. A `.gguf` is untrusted bytes from the internet and a
  deserialization target, not configuration. Pin the llama.cpp runtime
  version too: it is C++ with a real CVE history.
- **A clean security report does not mean the model is sandboxed.** Source
  scanners read source; confinement is a property of how the process was
  launched, so its absence leaves **no trace in source** and produces no
  finding. Verify against the **running process** and record that check with
  its date. Until then the status is `needs_validation`, not "passed".

## Operations never to run on a development machine

- The NSIS installer, silent `/S` included. It writes to the live `BASE_DIR`
  and would overwrite the working install's config. Verify that the artifact
  *builds*; do not install it here.
- `graphify install` / `graphify claude install`. They overwrite the local
  graphify skill file, rewrite the instruction file, and inject `PreToolUse`
  hooks into the local Claude settings.
