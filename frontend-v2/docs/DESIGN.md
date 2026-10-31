# Design contract — "Ledger"

**Every agent building in `frontend-v2/` follows this file exactly.** It is the
reason three parallel agents produce one coherent app instead of three.
Do not invent a colour, a font, a radius or a shadow that is not here.

## The brief

- **User:** a practising CA / tax consultant with a caseload of Income Tax
  notices, working to statutory deadlines.
- **Job of the app:** turn a scanned notice into a defensible, citation-backed
  reply that can be filed.
- **Hero:** the drafting workspace — notice on the left, reply on the right.
  Not a dashboard, not a landing page, not a chat bubble stream.
- **What the user actually verifies:** the citations. The layout must make
  checking them physical and fast, not bury them in a footer.

## Direction

Ink on paper, but **cold** — the colour of a photocopied assessment order, not
warm cream. The visual world is the statutory document: the notarial stamp, the
pleading margin, the section reference. Authority without pastiche.

Explicitly rejected as generic defaults: warm cream `#F4F1EA` + terracotta;
near-black + acid green; identical rounded cards with the same soft grey shadow;
ALL-CAPS tracked eyebrow labels; `01 / 02 / 03` markers on content that is not
a sequence; `→` glued to button text.

## Colour

Cool paper greys, one indigo accent, one vermilion held in reserve.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#F2F1ED` | `#101317` | App background, and the window caption |
| `--surface` | `#FBFAF7` | `#171B21` | Panels, cards, inputs |
| `--surface-sunken` | `#E8E7E2` | `#0C0E12` | Wells, code blocks, the notice pane |
| `--ink` | `#15181D` | `#EEF1F6` | Primary text |
| `--ink-muted` | `#5A6472` | `#98A3B4` | Secondary text, labels |
| `--ink-faint` | `#5F6773` | `#8A94A4` | Timestamps, counts, placeholders |
| `--rule` | `#DCDAD3` | `#262C36` | Borders, dividers, the margin rule, caption hover |
| `--rule-strong` | `#79818E` | `#6A7584` | Control boundaries that owe 3:1 — input, Select, Switch track |
| `--seal` | `#2B3A8C` | `#8A9BE8` | **The accent.** Primary actions, active nav, focus ring, citation tags |
| `--seal-wash` | `#ECEEF7` | `#1B2140` | Accent-tinted backgrounds — used sparingly |
| `--vermilion` | `#BE2F28` | `#F0756C` | **Reserved.** Deadlines, destructive actions, errors only |
| `--vermilion-wash` | `#F7E9E7` | `#2A1513` | Error/destructive backgrounds |
| `--on-vermilion` | `#FFFFFF` | `#101317` | Text on a solid vermilion fill. Not white — see the rule below |
| `--viridian` | `#1F6F56` | `#5FBE9A` | Success, "model ready", sync complete |
| `--viridian-wash` | `#E5EFE9` | `#10271F` | Success backgrounds |
| `--amber` | `#8A5A00` | `#E0A54A` | Degraded state, unverified citations |
| `--amber-wash` | `#F7EEDA` | `#2A1F0D` | Degraded/unverified backgrounds |

Rules:
- **Vermilion is never decorative.** If it is not a deadline, a delete, or an
  error, it is not vermilion.
- **Never `white` on a vermilion fill.** Vermilion flips lightness between the
  themes, so white measures 5.79 on the light fill and 2.81 on the dark one.
  Use `--on-vermilion`, which is whichever of the two is legible.
- Dark mode is a real theme, not an inversion. Both columns above ship.
- Never a gradient as decoration. No `rgba(0,0,0,.1)` drop shadow under
  everything.

## Type

Three faces, each with one job. Self-hosted or system — **no Google Fonts CDN
call**, the app must render identically with no network (see Constraints).

| Role | Family | Notes |
|---|---|---|
| Reply body | `Newsreader`, Georgia, serif | The reply *is* a legal document; it reads like one. 1.7 line-height, max 72ch measure. |
| UI chrome | `Inter Tight`, `Segoe UI`, system-ui | Labels, buttons, nav, tables. |
| Data | `JetBrains Mono`, Consolas, monospace | Section refs, circular numbers, document IDs, session ids, file paths. |

Scale (Elements of Typographic Style, 1.25 ratio off a 16px base):
`12 / 14 / 16 / 20 / 25 / 31 / 39px`. Weights: 400, 500, 600 only.

Forbidden typographic tells:
- No ALL-CAPS labels. Sentence case, always.
- No accenting one word of a heading in a different colour or italic.
- No `A · B · C` middle-dot meta strings.
- No `WORD — fragment` spaced-em-dash label construction.
- No unnecessary label above content that is already self-evident.

## Layout

The window has no OS title bar. `decorations: false` in `tauri.conf.json`
removes it, and a 32px caption drawn in the app's own palette replaces it —
the Windows frame is a grey band with its own type and its own radius, and on
a light theme it sits above the page like something another program installed.

Below the caption: three zones. A fixed left rail, and a split work surface.

```
+---------------------------------------------------------- 32px caption ---+
|                                                       [ _ ] [ [] ] [ X ]   |
┌────────┬──────────────────────────────┬─────────────────────────────┐
│        │  NOTICE                      │  REPLY                      │
│  rail  │  ┌────────────────────────┐  │ ┌──┬──────────────────────┐ │
│        │  │ drop / uploaded files  │  │ │  │                      │ │
│  Draft │  ├────────────────────────┤  │ │ m│  Newsreader body     │ │
│  Corpus│  │                        │  │ │ a│  72ch measure        │ │
│  Settin│  │  extracted text        │  │ │ r│                      │ │
│        │  │  (sunken, mono-ish)    │  │ │ g│  s.148A(b) ◄ pinned  │ │
│        │  │                        │  │ │ i│                      │ │
│  ──────│  ├────────────────────────┤  │ │ n│                      │ │
│ session│  │ instruction + model    │  │ │  │                      │ │
│  list  │  │ [ Draft reply ]        │  │ └──┴──────────────────────┘ │
└────────┴──────────────────────────────┴─────────────────────────────┘
   240px            minmax(380px, 1fr)        minmax(480px, 1.2fr)
```

The caption carries no title text. The app's name is in the rail already, two
inches below; printing it again is the kind of chrome the rest of the
interface refuses. The empty span is the drag region. Close is the one control
that fills with vermilion on hover — a destructive action, which is one of the
three uses the colour is reserved for. The buttons are square and flush to the
window edge, with no radius and no gap, so a cursor flung into the corner
still lands on close.

- Left-aligned throughout. Nothing centred except a genuinely empty state.
- The split is resizable; it collapses to stacked panes under 1100px, and the
  rail becomes a top bar under 760px.
- Panels are separated by **1px rules**, not by shadow and not by gaps between
  floating cards. Radius `6px` on controls, `10px` on panels. One radius per
  role, not one radius for everything.
- Spacing scale: `4 / 8 / 12 / 16 / 24 / 32 / 48px`.

## Signature — the statutory margin

The reply pane has a true left margin rule, like a legal pleading. Every
citation the model emitted (`s.148A(b)`, `Circular 19/2023`,
`Notification 35/2023`) is parsed out of the reply text and **pinned into that
margin at the line it supports**, as a mono tag in `--seal`.

- Hovering a margin tag highlights the sentence it belongs to.
- Clicking it opens the source in the corpus view when that document is indexed,
  or marks it **unverified** in `--amber` when it is not — the single most
  valuable thing this app can tell a CA is *"this citation is not in your
  corpus."*
- This replaces a generic "Sources" accordion at the bottom. It is the one
  bold element; everything around it stays quiet.

## Motion

One orchestrated moment, nothing scattered.

- The **draft stream** is the moment: the reply types in, and each citation tag
  slides into the margin as its line resolves. That is the app's one piece of
  choreography.
- Everything else: state feedback only (open, expand, confirm). 120–180ms,
  `cubic-bezier(.2,.6,.2,1)`.
- No fade-and-slide-up on every section. No hover transition on every card.
- `@media (prefers-reduced-motion: reduce)` disables the stream animation and
  renders the reply complete.
- **The whole vocabulary is three animations**: `tag-in` and `pop-in`, both
  declared in `tailwind.config.ts`, plus Tailwind's built-in `animate-spin`
  for indeterminate progress. The last one is in scope deliberately — the
  config `extend`s the theme rather than replacing it, so the built-in
  survives, and a busy spinner is state feedback, which this section already
  allows. It must stay `motion-safe:`-prefixed. Anything beyond these three
  is new choreography and needs a reason.

## Copy

- Sentence case. Active voice. A control says what happens: **Draft reply**,
  not Submit. **Save as .docx**, not Export.
- An action keeps its name through the flow: the button says *Draft reply*, the
  status says *Drafting*, the result header says *Draft*.
- Name things as the user does: **Notice**, **Reply**, **Corpus**, **Citations**,
  **Session**. Never "payload", "endpoint", "vector store", "chunk" in the UI.
- Errors say what happened and what to do, in the interface's voice, and never
  apologise: *"No model file is set. Choose one in Settings."*
- Empty states are invitations: *"Drop a notice to start."*

## Quality floor — not optional, not announced

- Responsive to 360px. Keyboard-reachable everything, visible `--seal` focus
  ring (2px offset, never `outline: none` without a replacement).
- Every control has an accessible name. Live regions for streaming and status.
- Contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text and UI boundaries, in
  **both** themes.
- Dark mode respects `prefers-color-scheme`, with a manual override that
  persists.

## Hard constraints — breaking these breaks the product

1. **Never touch `frontend/`.** It is the stable fallback. `frontend-v2/` is a
   parallel tree and imports nothing from it.
2. **No network at runtime.** No Google Fonts link, no CDN script, no remote
   image. Fonts ship as local files or fall back to system faces, so the UI
   renders with no internet. The app itself is not offline: case-law sync and
   the model download reach out. Never describe it as fully local or fully
   offline.
3. **The API contract is fixed** — HTTP routes and `window.localAgent` field
   names are frozen. Read them, never rename them. See `docs/API.md`.
   v2 is **Tauri**, so the host side is Rust commands rather than Electron IPC,
   but the renderer-facing `window.localAgent` shape is identical by design.
4. **`indiankanoon_token` is a secret.** Render it masked, never log it, never
   put it in an error message or a console statement.
5. **Tailwind + Radix primitives only** for the component layer. No Fluent UI,
   no MUI, no component library that ships its own design language — the point
   of v2 is that the design is ours.
6. No `any`. No `@ts-ignore`. `npm run typecheck` must pass clean.
7. **The renderer runs in WebView2, not Chromium.** It is Chromium-based and
   current (154 on this machine), so modern CSS is fine — but the renderer has
   **no Node API at all.** No `require`, no `process`, no `node:fs`. Anything
   touching the filesystem, a process, or the shell goes through a Rust command
   on the bridge.
