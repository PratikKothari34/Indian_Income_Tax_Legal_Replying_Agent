# Environment notes

Verified on this machine. Each entry is a trap that has already cost time here
— not general advice.

## Shell

- **Commands are run in PowerShell 5.1.** No `&&` chaining (use `;` or
  `if ($?) { }`), no bash heredocs, backtick is the escape character. A
  working Bash command pasted into PowerShell still fails.
- **`pkill` does not exist.** Use `tasklist` / `taskkill`.
- **`jq` is not installed** (exit 127). Anything shelling out to it — hook
  commands, config-validation snippets copied from docs — parses fine, runs,
  and silently does nothing. Use `py -3.12` with the `json` module, and
  verify by diffing key sets, not by eyeballing output.
- **`ls a b c` exits non-zero if any target is missing** and short-circuits a
  `&&` chain. Use `;` or `|| true` for probe chains, and read the output
  before retrying — the content usually arrived anyway.
- **Bash heredocs eat backslash escapes and die on non-ASCII, apostrophes, or
  an unbalanced quote in prose.** Write the script to a file instead when the
  content has `\x`, `\0`, a quote, or any non-ASCII character.

## Python

- **`python` is ambiguous. Pin `py -3.12`.** In the Bash tool bare `python`
  resolves to msys2 Python 3.14 (`/c/msys64/ucrt64/bin/python`), which lacks
  most pip packages; user-installed packages live under Python 3.12, the `py`
  launcher default. A script that works by hand and fails under an agent is
  almost always this.
- This project's venv is `backend/.venv`. Activate it rather than guessing an
  interpreter.
- **Pass Windows-style paths** (`C:\...`), not msys `/c/...`, to Python.

## Files and encoding

- **Edit env files with a BOM-free, LF write:**
  `io.open(path, "w", encoding="utf-8", newline="\n")` under `py -3.12`.
  Never PowerShell redirection or `Set-Content` — those prepend a UTF-8 BOM
  (`EF BB BF`), `dotenv` does not skip it, so it reads the first line as
  `\uFEFFKEY` and **only the first variable silently goes missing.**
- **Env files override code defaults.** Update the real file, not just the
  example.
- **No em-dashes or smart quotes in Bash/curl JSON payloads.** Git Bash
  mangles the UTF-8 and stores `U+FFFD`. Keep payloads plain ASCII.
- **Measure line endings with `git ls-files --eol`**, or on the raw blob
  (`git cat-file blob <sha>`). Grepping the working-tree file for a carriage
  return answers a different question than what git stored.

## Build and processes

- **A running `.exe` holds its own file and `cargo build` fails with
  `os error 5` (Access is denied).** Kill `itax-reply-agent.exe` and
  `backend-rs.exe` before rebuilding, not after reading the error.

## Network

- **HTTP 200 does not mean a page exists.** Vendor sites serve *soft 404s*:
  status 200 with a "Page Not Found" body. A status-code-only link check
  reports them as live — inspect the response body. `HEAD` is widely
  rejected; use `GET`.
- **A settings API `PATCH` can return 200 and change nothing.** A write
  needing an entitlement the account lacks silently no-ops. Verify every
  settings write with a fresh read, and don't retry a silent no-op as if it
  were transient.

## Cloud sync

- **The repo sits inside OneDrive.** Sync can hold file locks mid-write and
  replicates anything written there, so **excluding a file from git does not
  make it private** — it still lands in the cloud account.
- The working tree has drifted behind `HEAD` before, producing re-derived
  work that was already committed. Check `git status` and `git log` before
  concluding something is undone.

## Two traps that make a dead check look alive

- **`.gitignore` does not apply to an already-tracked file, and git reports
  no error when a rule is dead.** Adding a directory to `.gitignore` while a
  file inside it was already committed looks correct and does nothing. Fix
  with `git rm -r --cached <path>`, which untracks without deleting. The only
  proof is `git check-ignore -v` printing a match.
- **A trailing-slash rule excludes a directory so completely that a later
  negation cannot re-enter it.** To publish one file out of an excluded
  directory the rule must be `dir/*` plus `!dir/keep-this.md` — `dir/` plus a
  negation silently keeps the file out.
