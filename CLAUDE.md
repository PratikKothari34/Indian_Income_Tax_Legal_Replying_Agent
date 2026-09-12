# CLAUDE.md

## Working rules (apply to every response)

1. Technical language, with simple English alongside. Don't overexplain.
2. No filler words.
3. To the point.
4. If something feels wrong, ask.
5. Elaborate only when asked.
6. Check outputs twice before asking, then rule 4.
7. Run `git commit` and `git push` directly. No `Co-authored-by` trailer. Rewriting pushed history — rebase, amend, force-push — needs the user's go-ahead first.
8. Bulleted format preferred.
9. When a rebuild or the complex solution is right, use it. Never recommend a cheap option that isn't the best.

Also:

- No absolute system paths in commit messages.
- Act once decided — raise a concern once, then execute.

## Source of truth

- Order: `CLAUDE.md` → `docs/decisions/` → continues if absolutely required.
- `docs/MASTER.md` is a consolidated read, not an authority. It loses on decisions, wins on numbers.
- `CLAUDE.md` is the only project instruction file — no local or private variant.
- `docs/memory/` is the portable copy of path-keyed memory. Renaming or moving the workspace folder orphans the original.
