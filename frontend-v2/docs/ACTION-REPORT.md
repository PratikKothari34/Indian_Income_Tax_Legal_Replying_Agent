# Action report — frontend-v2

**Date:** 14 October 2026
**Request:** a new, parallel, production-ready frontend, built subagent-driven,
criticized by subagents between development phases, with `frontend/` left
untouched as the stable fallback.

---

## Status in one line

**It is built, it launches, and the backend drafts.** `POST /generate`
returned HTTP 200 in 6.2s with a real s.143(2) reply, generated on the local
GPU through llama.cpp. Everything below separates what was verified by
running it from what was only read.

### What was verified how -- read this before trusting anything below

Two different limits, often confused. **The window can be photographed. It
cannot be clicked.**

- **Rendering IS verified.** The running window is captured with
  `PrintWindow` + `PW_RENDERFULLCONTENT` (0x2) -- the flag that makes a
  DWM-composited WebView2 surface render instead of returning black. The
  capture script is reusable and the Draft screen has been inspected as
  pixels across several builds. **Three visual defects were found this way
  and fixed**, each re-captured afterwards to confirm:
  1. a status detail line naming the model, wrapping to two lines in the
     most persistent slot in the window;
  2. the always-lit green "Ready" dot -- a marker in the normal state that
     cost the abnormal states their urgency;
  3. the Draft pane's empty state reading "Drop a notice to start." in a
     pane that accepts no drops.
  The whole healthy-state status block is now gone, confirmed on screen.
- **Input is NOT, and cannot be from here.** `SendInput` returns 1 with
  `GetLastError` 6, and `WindowFromPoint` confirms the coordinate lands on
  `Chrome_RenderWidgetHostHWND`. Native caption buttons accept clicks; web
  content does not. **No button in this frontend has ever been pressed**,
  and the `POST /generate` above was issued directly against the backend,
  not through the renderer.
- **So "functional" means: it compiles, it typechecks, its tests pass, it
  launches, it renders correctly, and the backend it talks to answers.** It
  does not mean any control was operated. The renderer-to-backend wiring is
  verified statically -- all 10 HTTP routes the renderer calls exist on the
  backend, and all 14 `invoke()` targets match registered Tauri commands,
  zero mismatches either direction -- but never by use.
- **"Good looking" is a human judgement and remains the user's call.** What
  can be said is that it has been looked at, criticised against
  `docs/DESIGN.md`, and corrected three times on the strength of what the
  screenshots showed. The user has also rejected specific details in
  review; those are fixed. No blanket approval has been given.

The remaining gap is operation, not appearance. It closes the moment someone
clicks through the app by hand.

---

## What was built

A new Tauri desktop frontend at `frontend-v2/`, parallel to the existing
Electron app, which was not touched.

| Part | Size | What it is |
|---|---|---|
| `frontend-v2/src` | 36 files, ~8,060 lines | React + TypeScript UI |
| `frontend-v2/src-tauri/src` | ~1,660 lines | Rust host: window, config, backend spawn |
| `backend-rs/src` | ~8,050 lines | Rust backend on llama.cpp |

**19 UI primitives** hand-built on Radix behaviour — Button, TextInput,
TextArea, Select, Slider, Switch, Tabs, Dialog, Popover, Tooltip, Toast,
Badge, Panel, Field, EmptyState, Spinner, IconButton and two helpers. Not a
component library: the request allowed one, but a kit would have brought its
own visual identity and the brief was a specific one.

**7 screens**: the draft workspace and its split panes, the notice pane, the
reply document, the session list, the corpus view, and settings.

### The design

"The Ledger" — cool paper greys, India-ink indigo `#2B3A8C` as the single
accent, vermilion `#C8322B` reserved strictly for deadlines, destructive
actions and errors. Newsreader for prose, Inter Tight for the interface,
JetBrains Mono for refs and identifiers.

The signature is **the statutory margin**: citations pin to the exact line
they support, and a citation that is not in the index is flagged amber as
*unverified* rather than quietly rendered as if it were. For a tax tool, a
hallucinated section number that looks identical to a real one is the whole
risk, so the design makes the difference visible.

---

## The critique passes

Three read-only subagents, three lenses, run between development and this
report.

| Lens | Reported |
|---|---|
| Design-contract fidelity vs `docs/DESIGN.md` | 10 blocking, 3 editorial |
| Accessibility + React correctness | 5 WCAG blockers, 4 high React bugs |
| Integration + security | 2 blocking, 10 contract/desync |

### The honest part: the reports were not reliable

**Five claims were checked and found wrong.** They are listed in
`frontend-v2/docs/BUILD-STATE.md` so nobody re-applies them. The pattern
matters more than the list: the agents reported confidently about code they
had read quickly, and about a third of the specific claims I checked did not
survive contact with the file. Everything acted on below was verified first,
usually by computing or executing rather than reading.

Two examples of what that changed:

- An agent flagged `ReplyDocument` as animating with no reduced-motion
  gating. A gate **was** already threaded through. The real flaw was narrower
  and different: a ref captured the OS preference once at mount, so toggling
  the setting did nothing until remount.
- An agent flagged an "empty live region" in `App.tsx`. The region had real
  text. The actual gap was that the remedy sentence never rendered in the
  compact layout — so a screen reader user heard the problem but not the fix.

---

## What was fixed, and how it was verified

### Contrast — computed, not judged

Every token was measured against every real background it sits on. Two values
carried forward from an earlier pass turned out to **fail** and were replaced.

| Token | Was | Now |
|---|---|---|
| `--ink-faint` light | `#8b95a5` — 2.68 FAIL | `#656d7a` — **4.62** |
| `--ink-faint` dark | `#6b7584` — 3.71 FAIL | `#8a94a4` — **5.64** |
| `--rule-strong` light | (new) | `#828a98` — **3.08** |
| `--rule-strong` dark | (new) | `#6a7584` — **3.70** |

`--rule-strong` then went on the control boundaries that need 3:1: the text
input, the Select trigger, and the Switch track — whose off state was a
**1.15:1 fill**, an invisible control.

### Accessibility

- **Slider had no accessible name.** Radix puts `role="slider"` on the Thumb,
  not the Root, so the label was being spread onto the wrong element.
- **A per-second counter sat inside a live region.** "Polite" governs
  interruption, not frequency, so a screen reader would read the clock for the
  whole draft and the user could hear nothing else. Split into an `sr-only`
  region that announces once and a visible counter at `aria-live="off"`.
- **Reduced motion** now gates at the CSS layer (`motion-safe:`) rather than
  through a ref read once at mount.
- A redundant live region on the corpus stats was removed — the Toast already
  announces sync completion.

### Correctness

- **Error messages described the wrong product.** `describeDraftError`
  regex-matched prose for `/ollama|unreachable|not running/`, so an HTTP 400
  ("Model name is too long") was reported to the user as a dead model server.
  Replaced with a `GenerateError` carrying the HTTP status, branching on it.
  Also swept the UI copy: "Pull one in Ollama" → "Set a model file in
  Settings", and a shell hint that was both the v1 Python backend *and*
  invalid PowerShell.
- **An upload could overwrite a newer one.** Added a request-generation guard
  on its own ref — deliberately not shared with the draft's, which would have
  made an upload cancel an in-flight draft.
- **The Settings Inference tab was non-functional.** It still edited `ollama_*`
  keys the host no longer writes, and had **no field at all** for the model
  path — the only way to point v2 at a model was hand-editing JSON. Rewritten
  against the host's real config contract, then **cut back again to what a
  normal user can act on** — see below.
- **The settings panel could brick the install.** Saving a `backend_port`
  outside 8000-8003 left a backend that runs perfectly and a renderer whose
  own CSP blocks it from ever reaching it, Settings included; recovery was
  hand-editing `config.json`. Both validators had accepted 1024-65535. The
  port is now clamped to the fallback chain and the field is gone from the UI,
  with a test that reads the real `tauri.conf.json` and fails if the CSP and
  the chain ever drift. **Mutation-checked** rather than assumed: the conf was
  temporarily drifted, the test failed as intended, the conf was restored.
- **Four controls did nothing at all.** System tray and Keep awake are
  persisted and unimplemented — no tray icon is constructed, nothing calls
  `SetThreadExecutionState`; the income-tax PDF toggle only pushes an
  explanatory error into the sync report. All cut, along with three
  absolute-path model-server fields a user cannot fill in correctly. Safe to
  cut because `save_config` is `unwrap_or(current)` per field and
  `write_config` merges over the on-disk file — **checked before cutting, as
  the alternative was silently erasing settings.**
- **No file picker existed.** Pointing v2 at a `.gguf` meant typing an
  absolute path from memory, with no feedback until the next draft failed.
  The dialog plugin was registered, permitted and installed — simply never
  called.
- **Two hardcoded drafting defaults** (`useState(0.2)`, `useState(false)`) are
  now real preferences, stored host-side because the backend takes both per
  request. `reset` returns to the stored preference instead of `false`.
- **In dev, Settings silently did nothing.** Three host path helpers lacked
  the `is_packaged()` branch their neighbours had, so the host wrote a config
  file the running backend never read. Saving appeared to work and changed
  nothing.
- **The corpus view announced success on a stall.** Completion was inferred
  from a 15-second grace plus three quiet polls, so any ~9s pause during
  re-embedding declared "The index is rebuilt". Now reads the backend's
  `sync_in_progress` flag. The subtlety: that flag cannot distinguish "not
  started yet" from "finished", so a job arms on first seeing it true, and
  only an armed job completes on false. A sync whose timestamp is unchanged
  after the flag drops never reached its status write — that is now reported
  as a crash instead of being announced as success using the *previous* run's
  result.

### Design-contract drift

- Split panes had no pixel floors, so the reply could be squeezed below a
  readable measure. Restored the contract's `380px` / `480px`.
- Mono was leaking onto prose; the scale reserves it for refs, IDs and paths.
- Toast borders were at `/20`–`/30` alpha, measuring 1.4–1.9:1. Set to full
  strength, measured 4.9–5.3:1.
- **Badge borders were dropped entirely.** Measured 1.32–1.62:1 against their
  own wash — a line nobody can see. Full strength would have cleared 3:1 but
  measured 5.3–10.1:1 against the surface, making a row of badges the loudest
  thing on screen, which is exactly what the component exists to avoid. A
  badge is not a control, so the 3:1 boundary rule does not reach it, and its
  state is already carried by text at 4.7–8.9:1. The `neutral` tone keeps its
  border, because its fill is `sunken` and on a sunken surface it would
  otherwise have no edge at all.
- `ToastTone` narrowed from four members to the contract's three; nothing used
  the fourth.

---

## Verification

### Passing

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (frontend-v2) | **clean** |
| `cargo test` (backend-rs) | **142 passed** |
| `cargo test` (src-tauri) | **34 passed** |
| `cargo check --all-targets` (src-tauri) | **clean, no warnings** |
| `npx vite build` | **clean, 4.36s, 151 modules** |
| Model-path validator, 17 cases | **17/17**, run against the real source |
| Citation parser, 14 formats | **14/14**, executed under Node |

Two of those were executed rather than reasoned about on purpose, after an
earlier bug in this project was missed by reading code that looked correct.

### Run, not just read

| Gate | Result |
|---|---|
| `cargo build --release` (src-tauri) | **succeeded**, 7m21s |
| App launch, backend spawn | **host + backend both live**, `/health` 200 |
| Clean shutdown | **no orphaned backend** after killing the host |
| `/health` with a model loaded | **`"status":"ok"`** |
| `POST /generate` | **HTTP 200 in 6.2s**, real s.143(2) reply |
| Spacing-scale audit, all components | **179 tokens, 1 real miss found and fixed** |
| CSP/port-chain drift test, mutation-checked | **fails when drifted**, conf restored |

The model is `qwen2.5-3b-instruct.gguf`, copied out of Ollama's blob store —
copied rather than symlinked, because a symlink needs elevation on Windows
and a copy leaves Ollama's own store untouched.

### Still not done

1. **The GUI has not been inspected screen by screen.** It launches and the
   window renders; nobody has walked every screen and every state.
2. **The frameless window's edge behaviour, mostly answered since.** The
   maximized case turned out to be a real bug — the window clipped its own
   caption by 7px — and was found by measuring the window against the work
   area, then fixed. `WS_THICKFRAME` was confirmed still set afterwards, so
   resize and snap are structurally intact. Dragging each edge and snapping
   left/right is still a hand test.
3. ~~**No installer has been produced.**~~ **Built and verified.**
   `Income Tax Legal Reply Agent_2.0.0_x64-setup.exe`, 9.12 MiB.
   `makensis` accepting `src-tauri/installer.nsh` is the only real validation
   an NSIS script gets short of running it, and running it here is
   forbidden. Contents confirmed by listing the archive rather than trusting
   the size: `itax-reply-agent.exe` (5.0 MB) and `backend-rs.exe` (29.1 MB,
   carrying the port fix) plus the `nsDialogs`/`nsExec` plugins the hook
   calls — 34.2 MB solid-LZMA'd to 9.5 MB. **Still never run it on the
   development machine**, `/S` included.

### Bugs found by actually running it — all since fixed

The backend assumed llama.cpp's port was free. On this machine
`ApplicationWebServer.exe`, a Windows service, already held 8080: the backend
connected, got a 404 from something that is not llama-server, and surfaced
`llama-server returned 404` — accurate, and useless for diagnosing it.

**Now fixed in code**, not just worked around. The distinction that matters is
that a sick llama-server and a foreign occupant need *opposite* remedies: one
wants restarting, the other wants the port changed, and restarting into a held
port merely reproduces the failure. So `LlamaHealth` carries
`port_occupied_by_other`, set when both `/props` and `/health` answer and
neither response is llama-server's, and `ensure_running` refuses to spawn into
that port rather than launching a child that dies on bind. Both messages name
`llama_port` as the setting to change.

Tested against a **real listener** on an ephemeral port rather than a mock —
the bug is about behaviour over an actual socket — with a closed-port case so
a free port is never misreported as occupied, and **mutation-checked** by
inverting the flag and confirming the test fails.

**Three more came out of running the packaged build**, none of which any
amount of reading would have produced.

**The maximize and minimize buttons did nothing.** Not the component -- the
component was correct. `capabilities/default.json` granted `maximize` and
`unmaximize`, but `toggleMaximize()` is a **separate** Tauri command behind
its own `toggle-maximize` permission, so the IPC call was rejected: no error,
no panic, no log, just a dead button. Double-clicking the caption failed for
a second reason, `internal-toggle-maximize`, which is what
`data-tauri-drag-region` invokes and which nothing in the renderer names.
Both added, plus `unminimize`, and verified in the **generated** manifest
rather than the source file. Pinned by a test over the nine permissions the
caption depends on, mutation-checked by removing one.

**The window opened past the taskbar.** 1440x920 is fine at 100% scaling and
too tall at 125%, where the work area is 811 CSS px. Now clamped to the work
area at startup while the window is still hidden, shrink-only. The second
half of this one is the interesting half: the first fix logged success and
the window was *still* 27px over, because `set_size` on an undecorated
window sets the **client** size and Windows adds the whole non-client frame
on top -- including 29px of caption height that `decorations: false` does not
remove and nothing draws. Corrected by measuring the real outer size and
subtracting, not by computing from `SM_CYCAPTION`, which is per-monitor-DPI.

**The schedule picker could not express a schedule.** The index-refresh
dropdown offered five presets: two daily times, a weekly, a monthly, a
custom. Cutting it to three frequencies was wrong on its own -- "Every week"
does not say which day, and nothing said at what time. It is now frequency
plus the detail that frequency implies -- a weekday when weekly -- and a
native time field in every case. A cron from Advanced that the controls
cannot express is shown as prose rather than forced into them, so saving
never silently simplifies it.

Monthly was then dropped on the user's call: a corpus refreshed once a month
is stale for most of it. That removed the day-of-month select and its 1-28
cap. It is a preset removal, not a validation change -- a monthly cron from
Advanced or inherited from v1 still saves and still runs, and the round-trip
suite pins that it is never quietly downgraded to daily.

**The time field was then rebuilt twice.** `<input type="time">` renders
WebView2's own picker -- two scrolling number columns in grey OS chrome with
a blue-on-white selection, dropped into the middle of a dark themed panel.
The first replacement was a themed select of every half hour grouped Night /
Morning / Afternoon / Evening: correct, themed, keyboard-operable, and still
a 48-row list, so reaching 2:30 am meant scrolling past twenty rows hunting
for a number.

The second replacement is a clock dial, because a list is the wrong shape for
a time -- a face is spatial, so 2 o'clock is a place you point at rather than
a string you search for. Two rings in the order a clock is read, hours then
minutes, advancing on pointer release rather than press so a drag does not
switch rings under the finger. The face is `aria-hidden` and the two readouts
above it are `spinbutton`s: a dial that only answered a pointer would be a
regression from the select it replaced, so arrows, Page up/down, Home/End and
Tab set the time without touching it. The native input's one real advantage
was knowing the machine's 12h/24h convention; `Intl.DateTimeFormat` supplies
that from the same source, so the trigger still reads `9:30 am` here. A
stored minute off the dial's 5-minute step is drawn at its true angle rather
than snapped, so an inherited 02:37 reads correctly.

132 assertions pin the geometry, lifted verbatim from the component -- the
bug that matters is the hand pointing somewhere other than where a click
lands. They cover that the face runs clockwise rather than mirrored, that
the forward and inverse mappings agree at all 60 positions, both wrap edges,
a click dead centre not yielding `NaN`, and all 24 round trips through the
12-hour/AM-PM split. 559 assertions still cover the half-hour list helpers,
which remain exported and tested although nothing in the UI calls them now.

**And that turned up drift between two validators.** Writing the host-side
test that every schedule the picker can build is accepted on save revealed
that `src/lib/format.ts` capped cron's day-of-week at 6 while both
`src-tauri` and `backend-rs` accept 7 -- deliberately, since cron spells
Sunday either way and a stricter host would refuse a config inherited from
v1. The UI was calling a valid, running schedule invalid. Widened to match,
with 7 normalised to 0 so the select matches an option instead of rendering
blank, and pinned from both sides.

**The window could not be half-snapped.** Driving Win+Left from Win32 showed
both snaps returning `1075x1022` where a true half of this screen is 976.
`minWidth` was 860 CSS px, which Windows enforces in physical pixels -- 1075
at 125% scaling -- so every half-snap came back 115px too wide and the two
halves overlapped. Lowered to 720; the snaps now return `976x1022` at x=-8
and x=952, meeting exactly. Nothing in the renderer had to change: it already
stacks the panes below 1100px and swaps the rail for a top bar below 760px,
so both of those paths existed and neither had ever been reachable. Pinned
against the real `tauri.conf.json`, mutation-checked by restoring 860.

## Known traps for whoever picks this up

- **A `{/* */}` comment directly inside a JSX `&&` branch is a syntax error
  that `tsc --noEmit` passes and only `vite build` catches.** Run the build,
  not just the typecheck.
- **`tailwind.config.ts` replaces the spacing scale** (it stops at 24). An
  off-scale utility like `max-h-64` compiles clean and emits **no CSS at
  all** — invisible to typecheck. **This is not hypothetical: the rebuilt
  settings panel used `gap-10`, which is off-scale, and its section spacing
  would have silently collapsed to zero. The audit is what caught it.** Re-run
  after adding components; the check is a diff of source tokens against the
  selectors in `dist/assets/index-*.css`, not against the config. Radix prop
  values on a `className` line (`position="popper"`) are known false
  positives.
- `public/fonts/*.woff2` are referenced and deliberately absent. Vite warns
  about four unresolved refs; that is intended graceful degradation to
  Georgia / Segoe UI / Consolas, not a defect.
- **No test runner is wired** in `frontend-v2/package.json`. The suites above
  ran as throwaway Node scripts. Making them permanent is a dependency
  change, so it is your call.
- **`installer/installer.nsh` is electron-builder-specific.** Tauri's NSIS
  bundler uses a different hook format; it needs porting before v2 ships as
  an installer.
- **v2 shares some state with v1 deliberately** — `auth_token.txt`,
  `rag/models/`, sessions and `output/`. A v1 uninstall that clears `data/`
  takes v2's sessions with it.
- Nothing is committed yet, which is correct per the commit policy: this
  lands as one commit once it has been launched and verified.

---

## One thing found and deliberately not fixed

`backend/README.md` claims the v1 backend is "fully-local" and that
"inference is entirely local". The app makes outbound calls to three hosts.
`git log` shows this wording **survived** the commit recorded as having fixed
it, so that earlier fix was partial.

Not corrected here, because `backend/` was out of scope by your instruction.
Flagging it rather than touching it.

---

## What I would do next, in order

1. The spacing-scale audit across all 38 components.
2. `cargo build --release` in `src-tauri`, then launch.
3. Symlink a GGUF out of the Ollama blob store and draft one real reply
   end to end.
4. Then, and only then, one commit.
