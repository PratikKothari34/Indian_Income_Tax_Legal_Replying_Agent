# 0001 — The project instruction file is local-only

**Date:** 2026-10-12
**Status:** accepted

## Decision

`CLAUDE.md` is gitignored and untracked. It lives on this machine only, is never
published, and does not survive a clone. `docs/memory/` is likewise gitignored.

`docs/decisions/` (this directory) is tracked and is the second entry in the
source-of-truth order, after `CLAUDE.md` itself.

## Context

`CLAUDE.md` was created and committed on 12 Sep 2026 (`48339b6`) as a tracked
file. On 12 Oct 2026 it was replaced wholesale with the cross-project template,
which specifies the file as gitignored and local-only.

## Consequences

- A collaborator cloning this repo gets **no** instruction file. Anything they
  must know has to live in a tracked file — `README.md`, a decision record
  here, or a code comment. Pointing a collaborator at `CLAUDE.md` is always
  wrong; they cannot see it.
- The path-keyed memory at
  `~/.claude/projects/<workspace-slug>/memory/` and its mirror in
  `docs/memory/` are now the only durable copies of the working rules and the
  hard constraints. Both are local. Renaming or moving this workspace folder
  orphans the path-keyed original.
- Losing this machine loses the instruction file. The template it came from
  (`#Tools/Project_Starter/CLAUDE.md`) is the recovery path.
