# frontend-v2 — build state

Written 2026-10-13, at the end of the three parallel build agents. This file
exists so the next session does not re-derive what is already on disk.

## What is done

Three build subagents delivered 38 source files under `frontend-v2/src/`,
with non-overlapping scopes:

| Agent | Scope | Files |
|---|---|---|
| primitives | `components/ui/*`, `components/icons.tsx` | 20 |
| draft workspace | `lib/citations.ts`, `hooks/*`, `components/app/Draft*`, `ReplyDocument`, `NoticePane`, `DropZone` | 7 |
| shell + corpus + settings | `index.html`, `main.tsx`, `App.tsx`, `styles/global.css`, `components/app/{Corpus,Settings,SessionList}`, `lib/format.ts` | 8 |

Verified by this session directly:

- `backend-rs`: 139/139 tests pass, zero warnings.
- `src-tauri`: `cargo check` clean.
- `lib/citations.ts` executed under Node against 14 real citation formats, a
  realistic 3-paragraph reply, and a corpus-verification case. All parsed;
  the slash survives (`19/2023` != `19/2019`); line indices correct.
- Contract audits clean by grep: no default Tailwind palette, no banned
  radius/shadow/spacing, no ALL-CAPS eyebrow, no `01/02/03` markers, no
  arrow-glued buttons, no hardcoded ports.
- All 14 IPC commands match on both sides and are registered in
  `invoke_handler`.
- `indiankanoon_token` masking is correct: the key is omitted from the save
  patch entirely unless the user typed over the mask.

## The v1/v2 backend desync, closed this session

The Tauri host had been built against v1's contract and would have driven the
**Python** backend. Fixed in `src-tauri`:

- `backend.rs`: spawns `backend-rs.exe`, not `backend.exe`; dev path resolves
  `backend-rs/target/release` then `debug`; dev error message now says
  `cd backend-rs; cargo run --release`.
- `paths.rs`: `appdata_config()` -> `config-rs.json`, `appdata_port_file()`
  -> `port-rs.txt`. Reading v1's `port.txt` would have sent every request to
  whichever backend wrote last, silently.
- `tauri.conf.json`: bundle resource is `backend-rs.exe`.

## Screenshots work. Input injection does not. Don't conflate them.

Two separate limits, and an earlier version of this document wrongly merged
them into one.

**Capturing the window WORKS, and is the right first move on any UI
question.** Use `PrintWindow` with `PW_RENDERFULLCONTENT` (0x2). A plain
BitBlt of a DWM-composited window returns black for the WebView2 surface;
that flag is precisely the fix. Enumerate top-level windows for the title
"Income Tax", take the client rect, 32bpp top-down DIB, hand the buffer to
PIL as `BGRX`. Allow ~45s after launch for the backend cold start before
capturing, or the shot catches the "Starting" state.

This is not theoretical: three visual defects were found by looking at the
render and fixed, each confirmed by a follow-up capture. **If you are about
to claim something about how this app looks, photograph it instead.**

**Driving the UI does NOT work.** `SendInput` returns 1 with `GetLastError`
6; `WindowFromPoint` resolves the coordinate to
`Chrome_RenderWidgetHostHWND`. Native caption buttons accept clicks, web
content does not. **No control in this UI has been pressed by anything but a
human.** Every claim about renderer *behaviour* -- as opposed to appearance
-- comes from tests, from reading the code, or from driving the backend
directly. Treat interaction as unverified until you have clicked it
yourself; treat appearance as checkable right now.

## The three critique passes — run, reports in hand

All three ran read-only and handed back reports. **Their findings proved
unreliable in detail: five claims were checked and found wrong.** Verify
before acting on anything from them.

| Lens | Found |
|---|---|
| Design-contract fidelity vs `docs/DESIGN.md` | 10 blocking, 3 editorial |
| Accessibility + React correctness | 5 WCAG blockers, 4 high React bugs |
| Integration + security | 2 blocking, 10 contract/desync |

### Claims that were WRONG — do not re-apply

1. `tokens.css` has a comment falsely claiming 3:1 clearance. **No such
   comment exists.**
2. The Switch off-state uses `--rule` as a border. **It is a fill**
   (`bg-rule`). Still fixed, for a different reason.
3. `ReplyDocument` applies `animate-tag-in` ungated. **An `animate` prop was
   already threaded through.** Only the ref-captured-once flaw was real.
4. `App.tsx` status is an empty live region. **`tone.label` is real text.**
   The real gap was `tone.detail` going unrendered in compact layout.
5. Two carried-forward contrast candidates (`#6b7480`, `#8d96a3`) **both
   fail.** Recomputed and replaced.

### Fixed from the reports

- **Contrast**, computed against every real background, not eyeballed:
  `--ink-faint` light `#8b95a5` (2.68 FAIL) — `#656d7a` (4.62), dark
  `#6b7584` (3.71 FAIL) — `#8a94a4` (5.64). New `--rule-strong` light
  `#828a98` (3.08) / dark `#6a7584` (3.70), applied to the text input, the
  Select trigger and the Switch track.
- **Slider accessible name**: `aria-label` etc. now spread onto
  `SliderPrimitive.Thumb`, where Radix puts `role="slider"`.
- **Per-second live region**: split into an `sr-only role="status"` that
  announces once and a counter at `aria-live="off"`. Politeness governs
  interruption, not frequency.
- **Reduced motion**: `motion-safe:animate-tag-in`; the OS-preference ref
  that captured once at mount is gone.
- **Error classification** no longer regex-matches prose. `GenerateError`
  carries an HTTP status and `describeDraftError` branches on it — a 400
  used to be reported as a dead model server.
- **Settings Inference tab** rewritten: it edited `ollama_*` keys the host no
  longer writes and had **no UI at all** for `llama_model_path`.
- **Dev-mode split base dirs** in the host: `appdata_config/port_file/logs`
  lacked the `is_packaged()` branch, so in dev the host edited a config the
  backend never read — Settings appeared to save and changed nothing.
- **Upload race** in `acceptFile`, on its own `uploadIdRef`.
- **Split-pane floors**, mono-on-prose, Toast borders at full strength,
  `ToastTone` narrowed to the contract's three.
- **Badge borders dropped** on the coloured tones. Measured at 1.32-1.62:1
  against their own wash — a line nobody can see. Full strength would clear
  3:1 at 5.3-10.1:1 against the surface, making a row of badges the loudest
  thing on the page. A badge is not a control, and its state is already
  carried by text at 4.7-8.9:1. `neutral` keeps its border: its fill is
  `sunken`, so on a sunken surface it would otherwise have no edge.
- **Corpus sync completion** now reads `sync_in_progress` instead of
  inferring from a 15s grace plus 3 quiet polls, which declared "The index is
  rebuilt" on any ~9s stall. The flag cannot tell "not started" from
  "finished", so a job arms on first seeing it true and only an armed job
  completes on false. A sync whose `last_sync` is unchanged after the flag
  drops never reached its status write — reported as a crash, not read from
  the previous run's `last_sync_status`.

## "Save as .docx" re-ran the model and overwrote the draft

The worst bug found by the app-wide copy critique, and it was not a copy
problem. The button called `saveExistingDraft`, which called `/generate`
again with `save_output: true`. `runGenerate` then set the draft
unconditionally from the response, so pressing **Save** waited minutes for
inference and replaced the reply the user had been reading -- with a
*different* one, because the model is not deterministic. The `reuseTurn`
flag only kept the re-run out of the transcript; it never protected the
text.

The critic proposed renaming the button to "Draft again and save". That
accepts the behaviour. Saving should save.

- **`POST /save-docx`** (`backend-rs/src/routes/generate.rs`) takes
  `{ reply }` and writes the file: no inference, no session write, no
  history, milliseconds. A blank reply is a 400, a write failure a 500.
  The text travels in the body so an **edited** draft saves what is on
  screen. It joins `/generate`'s sub-router to inherit the 10 MiB body cap.
- **An addition, never a rename** -- an installed frontend that predates it
  keeps working.
- `saveExistingDraft` now sets only `outputFile`; `status`, `reply` and
  `history` are untouched, so nothing on screen flickers. It has its own
  `isSavingDocx` flag rather than borrowing the drafting status, and the
  button reads **Saving** while the write is in flight.
- `reuseTurn` is gone from `runGenerate`: with saving no longer going
  through it, the flag was always `false`.
- Verified against the running backend: a whitespace reply returned **400**,
  a real one returned **200** with a valid `.docx` whose `document.xml`
  contained both paragraphs.

## Shipped since the three passes

**End-to-end inference works.** `POST /generate` returned **HTTP 200 in 6.2s**
with a real s.143(2) reply, generated on the RTX 4060 through llama.cpp.

- The model is `qwen2.5-3b-instruct.gguf`, **copied** out of Ollama's blob
  store into `%LOCALAPPDATA%/ITaxReplyAgent/models/` — copied, not symlinked,
  because a symlink needs elevation on Windows, and copying leaves Ollama's
  own store untouched.
- An earlier HTTP 400 on the same call was **my test payload, not a defect**:
  the fields are `text` and `query`, not `notice_text`/`instruction`.
- **One real backend bug surfaced.** `ApplicationWebServer.exe`, a Windows
  service, already owned port 8080 — llama.cpp's default. The backend
  connected, got a 404 from a server that is not llama-server, and reported
  `llama-server returned 404`. It assumes the port is free rather than
  detecting a foreign occupant. Worked around by moving `llama_port` to 8090;
  **not yet fixed in code.** The system service was not touched.

**The window caption is drawn by the app.** `decorations: false`, plus
`components/app/TitleBar.tsx`.

- 32px, matching the Windows caption, so the window's proportions do not move.
- No title text: the rail already names the app two inches below.
- Two contrast failures were found by measuring and fixed before the build:
  white on the **dark** theme's vermilion is **2.81** (the fill is a light
  salmon there), and `sunken` as the hover wash is **1.04:1** against the
  caption's paper — a hover state nobody can see. New `--on-vermilion` token
  for the first; `rule` (1.33:1) for the second.
- Degrades to nothing outside Tauri, so `npm run dev:web` keeps the browser
  frame.
- **The maximized window clipped its own caption, and that was found by
  measuring it, not by looking.** An undecorated window keeps
  `WS_THICKFRAME` -- which is what preserves resize-from-any-edge and snap --
  and Windows then maximizes it to the work area *plus* the invisible resize
  border. Measured: work area `0,0-1536,811`, maximized window `-7,-7` to
  `1543,819`. The top 7px of the caption and the right 7px of the close
  button were off-screen. Fixed by leaving the window oversized (shrinking it
  fights the OS and breaks snap) and padding the content by the overflow the
  host measures at runtime -- not a constant, because the border scales with
  DPI: `SM_CXFRAME + SM_CXPADDEDBORDER` reports 8 unscaled where this display
  actually overflows by 7. Covered by five cases in
  `$CLAUDE_JOB_DIR/tmp/inset.mjs`, including 150% DPI, a second monitor at an
  x-offset, and a top-mounted taskbar.
- Window style confirmed from Win32 after the change: `WS_THICKFRAME` still
  set, so resize and snap are intact.

## The settings panel, cut to what a user can act on

Critiqued as a whole by a subagent, then **every claim re-verified against
source before acting on any of it** — a subagent report carries no authority
on its own. All of them held.

Was 764 lines across three tabs; now one scrolling page in four groups:
**Drafting**, **Case law and circulars**, **Windows**, and a collapsed
**Advanced**.

**It is a dialog, not a screen** (user's call, 15 Oct 2026). A gear
`IconButton` sits in the rail -- and in the compact top bar -- and opens the
whole panel in a `DialogContent` sized
`h-[85vh] max-w-[64rem]`, widened with the sidebar layout, with the dialog's
own padding and gap zeroed so
the panel's existing header and scrolling body work unchanged. `Screen` is
down to `"draft" | "corpus"`: settings is somewhere you go to change one
thing and leave, not a place you work, and as a third nav item it sat
permanently level with the two screens that are the app.

The panel's visible `<h1>` stays; the dialog's accessible name is an
`sr-only` `DialogTitle`, which Radix requires and warns about when missing.
Closing is the part that needed care -- Escape and the scrim both route
through `onOpenChange`, so `SettingsView` now reports `dirty` upward via
`onDirtyChange` and a close with unsaved edits asks first. Without it the
panel could say "Unsaved changes" and then throw them away on an Escape.

**Cut entirely**, with the reason recorded in the file header so nobody
restores them:

| Cut | Why |
|---|---|
| System tray, Keep awake | Persisted by the host and **not implemented** — no tray icon is ever constructed, nothing calls `SetThreadExecutionState`. Two switches that did nothing. |
| Backend port | Could brick the app. See below. |
| Income-tax PDF scraper | Enabling it only pushes an explanatory error into the sync report. |
| Model-server program / host / port | Three absolute-path fields a normal user cannot fill in correctly and does not need to. |

**The backend-port field could brick the install, and the fix is a clamp, not
a warning.** The renderer reaches the backend over `fetch`, gated by the Tauri
CSP: `connect-src` allows exactly `127.0.0.1:8000`-`8003`. Both validators
accepted **1024-65535**. Saving port 9000 therefore left a backend that starts
and answers perfectly while the renderer is permanently blocked from reaching
it — **including the Settings panel that would put it back.** Recovery was
hand-editing `config.json`. `save_config` now rejects any port outside
`PORT_FALLBACK_CHAIN`, and `backend::tests::the_csp_allows_every_port_in_the_fallback_chain_and_no_others`
reads the real `tauri.conf.json` and fails if the two ever drift. That test
was **mutation-checked**: `8003` was temporarily changed to `9999` in the
conf, the test failed as intended, and the conf was restored and verified.

**Cutting controls is safe, and that was checked before cutting.** `save_config`
is `unwrap_or(current)` on every field and `write_config` merges over the
on-disk file preserving unknown keys, so a key the panel no longer offers keeps
its stored value. Without that, this rework would have silently erased settings.

**Added:**

- **A native file picker** for both model paths (`lib/pickFile.ts`). The only
  way to point v2 at a `.gguf` was typing an absolute path from memory with no
  validation until the next draft failed. The dialog plugin was already
  registered, already permitted, and already in `node_modules` — never called.
  It lives renderer-side because routing it through a new Tauri command would
  widen the bridge surface for nothing.
- **A live model status line** with a "Check again" link. Settings never called
  `/health`; it was polled in `App.tsx` and never shown here. Wired to `check`,
  not `onRetry` — `onRetry` also restarts the backend, far too heavy for a link.
- **Two real preferences**, `default_temperature` and `always_save_docx`.
  `useDraft.ts` hardcoded `useState(0.2)` and `useState(false)`. Both are
  **host-only** keys: the backend takes them per request, so it must not learn
  them. `config.rs` documents that `the_host_and_backend_agree_on_the_config_key_set`
  is one-directional on purpose (host ⊇ backend) so nobody "fixes" it by adding
  these to `backend-rs`. Both carry `#[serde(default)]`, so an older config
  still parses.
- `reset` in `useDraft` now returns to the **stored** save-as-docx preference
  rather than hardcoded `false`, and a `draftPrefsTouched` ref stops a late
  config read from overwriting an edit the user already made.

**Advanced** is collapsed, unmounted when closed (an always-mounted hidden
panel is a keyboard trap), and **auto-opens when it contains a validation
error** — otherwise a rejected save points at a field nobody can see.

**The spacing audit caught a real bug on the way through.** `gap-10` is not on
this project's scale (`0, px, 1, 2, 3, 4, 6, 8, 12, 16, 24`), so it emits
**zero CSS** and the new section spacing would have silently collapsed to
nothing. Confirmed against the built file: `grep -c "gap-10" dist/assets/*.css`
→ 0. Changed to `gap-8`. The other two flags, `popper` and `start`, are Radix
prop values on the same line as a `className` — false positives.

`NoticePane.tsx` lost the line "0.2 is the default", which contradicts a
configurable default.

### The schedule picker: frequency, the day it implies, and a time

The panel shipped with five presets behind "Update the index" -- daily at
12:00, daily at 02:00, Mondays at 12:00, the 1st at 12:00, and "On a custom
schedule". Cutting that to three frequencies was the first move and was
**wrong on its own**: "Every week" does not say which day, and nothing said
at what time. A preset list that covered weekday x hour would run to 168
entries.

So the control is now frequency **plus the detail that frequency implies**:

| Frequency | Extra controls |
|---|---|
| Every day | time |
| Every week | weekday, time |

- **The time field is a clock dial.** It took two attempts to get there.

  It started as `<input type="time">`, which looked wrong: WebView2 draws
  its own dropdown for that -- two scrolling number columns, a blue-on-white
  selection and a grey OS panel, none of which the token system can reach.
  `Select.tsx`'s own header already states the rule it broke: the OS draws
  popups it cannot theme, which is why Radix owns every other listbox in the
  app.

  It became a themed select of every half hour grouped by part of the day.
  Correct, themed, keyboard-operable -- and still a 48-row list, so reaching
  2:30 am meant scrolling past twenty rows looking for a number. A list is
  the wrong shape for a time: a clock face is **spatial**, so 2 o'clock is a
  *place* you point at rather than a string you search for.

  `TimeDial.tsx` is an SVG face in a popover, two rings read in the order a
  clock is read -- hours, then minutes. The ring advances itself on pointer
  release, not on press, so a drag around the hour ring does not switch out
  from under the finger mid-gesture. **The minute ring is the outer one**
  (78 against the hours' 62). Both sat at 68 at first, which made the ring
  switch invisible: twelve numerals were replaced by twelve others in the
  same twelve places, so a second click at the spot that had just set 3
  o'clock set `:15` instead. The active readout is marked by an underline as
  well as a tint, because tint alone is colour-as-sole-signal, and the ring
  now follows **focus** rather than a click -- a native button fires its
  click on Space and Enter, neither of which means anything to a spinbutton,
  so clicking to switch had made those two keys silently change the ring. Minutes sit on a 5-minute step because
  twelve labelled positions is what a face has room for, and a background
  index refresh does not need 11:37.

  **The face is `aria-hidden`, and that is deliberate.** A dial that only
  answered a pointer would be a regression from the select it replaced. The
  two readouts above it are each a `role="spinbutton"`: arrows step, Page
  up/down jump a quarter turn, Home/End hit the ends, and Tab moves between
  them -- so the time is fully settable without touching the dial at all.
  Announcing twelve unlabelled tick marks on top of that would be noise, not
  access.

  The native input had one genuine advantage -- it knew the machine's
  12h/24h convention, and a pair of number fields would get that wrong for
  half the world. `Intl.DateTimeFormat` knows the same thing from the same
  source, so the *trigger* still reads `9:30 am` here and `09:30` where that
  is the convention, via `formatTimeOfDay`. Verified on this machine:
  `en-IN`, `hourCycle: h12`. The dial itself is 12-hour with an AM/PM pair,
  which is the only form a round face has.

  A stored minute off the 5-step -- written in Advanced, inherited from v1 --
  is **shown, not snapped**: the hand is drawn at its true angle and a dot
  marks the rim, so an inherited 02:37 reads correctly even though the ring
  cannot produce it. This is why the dial needs no equivalent of
  `nearestTimeOption`, which existed only because **a Radix select whose
  value matches no option renders blank**. `nearestTimeOption`,
  `timeOptions`, `TIME_GROUPS` and the `TimeOfDayGroup`/`TimeOption` types
  were deleted in the audit pass -- nothing called them, and there is no
  frontend test runner, so nothing covered them either.
- **Monthly is not offered.** A corpus that refreshes once a month is stale
  for most of it, so daily and weekly are the only cadences with a preset.
  This removed the day-of-month select and, with it, the 1-28 cap that
  existed because a 29th-31st schedule silently skips the short months.
- A cron the controls cannot express -- a step, a list, a month restriction,
  a day-of-month (monthly) schedule, both day fields at once -- is **not**
  forced into them. The picker is replaced by the plain-English gloss plus
  "Set in Advanced, below", because a picker that cannot represent a value
  would rewrite it into something simpler on the next save.

**Dropping monthly did not invalidate anything.** A monthly cron typed into
Advanced, or inherited from v1, still validates and still runs -- the host
and backend validators were not touched. It simply has no preset, so
`cronToSchedule` returns `null` and the raw expression is shown instead.
Pinned from both sides: the host suite still accepts `{m} {h} {1..28} * *`,
and the round-trip suite asserts such a cron is never downgraded to daily.

The mapping lives in `src/lib/format.ts` as `scheduleToCron` /
`cronToSchedule`, not in the component, so it is testable without rendering.
**277 assertions** on the cron mapping, including all **56** control
combinations (2 frequencies x 7 weekdays x 4 times) producing cron that is
both valid and readable back, full round-trips, and every unrepresentable
expression correctly returning `null`. A further **559** cover the half-hour
list helpers that the dial superseded but which remain exported: that the
four groups partition all 48 slots with no gap or overlap and stay
contiguous and chronological, and that **every** minute of the day snaps
onto an option that really exists, never forward past itself.

**135 assertions** cover the dial's geometry, lifted verbatim from the
component because a drift between the two is exactly the bug that matters --
a hand pointing at a different number than the one a click selects. They pin
that the face runs *clockwise* (9 is on the left; the sine term is subtracted
because SVG's y axis points down, and getting that wrong silently mirrors the
clock), that `pointOn` and `turnsAt` are exact inverses at all 60 positions,
that clicking each label selects that label on both rings, that a click dead
centre is finite rather than `NaN`, and the two wrap edges: a click just
anticlockwise of 12 yields raw slot 0 and just before `:00` yields raw 60, so
the `% 12` and `% 60` folds are load-bearing rather than defensive. Three
pin the ring separation itself: that minutes are outside hours, that a label
at the same angle really does move between rings, and that the outer ring
plus its 14px selection puck still fits inside the rim. Both key
domains are pinned too -- hours wrap 1..12, minutes 0..59, and End lands on
55 rather than 59, a value an arrow key can also reach -- along with all 24
round trips through the 12-hour/AM-PM split, where 12 am is `00` and 12 pm is
`12`. A half-typed time (`1:` while the user is still typing) must not emit
`NaN NaN * * *` and fail validation on a field they already filled -- pinned
by its own case.

#### The drift this found: Sunday has two spellings

Writing the host-side test `every_schedule_the_picker_can_build_is_accepted_here`
turned up a real disagreement between the two independent cron validators.
`src/lib/format.ts` capped day-of-week at **6**; `src-tauri/src/config.rs`
and `backend-rs/src/config.rs` both accept **7**, deliberately, because cron
spells Sunday either way and a stricter host would refuse to save a config
inherited from v1.

The frontend was therefore calling a schedule invalid that saves and runs
fine. Widened to 0-7, with `cronToSchedule` normalising 7 to 0 so the select
matches an option rather than rendering blank. The comment directly above
`CRON_FIELDS` already stated the rule -- "client validation that disagrees
either blocks a legal value or lets an illegal one through" -- and the value
below it broke it.

Pinned from both sides: `config::tests::sunday_is_accepted_as_both_zero_and_seven`
in Rust, and `both Sundays agree` in the JS suite.

### The window opened past the taskbar

`tauri.conf.json` asks for 1440x920. That is comfortable on 1080p at 100%
scaling and too tall at anything above it: at **125%** on a 1920x1080 screen
the usable work area is 1920x1014 physical (1536x811 CSS px), so the window
hung below it and the bottom of the app sat behind the taskbar. `center:
true` did not save it -- centring an oversized window just splits the
overflow between top and bottom.

Now clamped in `lib.rs::fit_window_to_work_area`, called from `setup` while
the window is still `visible: false` so there is no resize flash. It only
ever **shrinks**: a window that fits is returned untouched, because a large
monitor is not a reason to inflate the app.

**The part that is not obvious.** The first fix logged success and the window
was still 27px over. `set_size` on an **undecorated** window sets the
*client* size, and Windows then adds the entire non-client frame around it --
the invisible resize border on all four sides **and the caption height**,
29px of it, despite `decorations: false` and despite nothing drawing a
caption. Measured: a 974px request produced a 1021px window (+18 border,
+29 caption). So the function measures the real outer size after setting it
and subtracts the difference, rather than computing it from `SM_CYCAPTION`
and `SM_CXPADDEDBORDER`, which are per-monitor-DPI and differ on a second
display at another scale.

The arithmetic is split into a pure `fitted_size()` so the case that broke is
testable without a window or a monitor. Four tests, including the exact
1920x1014-at-1.25 geometry this shipped broken on, and a `saturating_sub`
case so an absurdly small work area clamps to zero instead of underflowing a
`u32`.

### The window could not be half-snapped

Found by driving Win+Left from Win32 rather than by reading anything.

`minWidth` was **860 CSS px**. Windows applies that minimum in *physical*
pixels, so the floor a user actually hits is `minWidth * scale` -- 1075px at
125%. Half of a 1920px screen is 960px. So Win+Left produced a window
**115px wider than the half it had been snapped to**, and the two halves
overlapped. Measured before the fix: both snaps returned `1075x1022`, where
a true half is 976 wide.

Lowered to **720**. Verified live afterwards: `Win+Left -> 976x1022 at
(-8,0)` and `Win+Right -> 976x1022 at (952,0)`; `952 + 976 - 8 = 1920`, so
the halves meet exactly and no longer overlap. The 8px is the invisible
`WS_THICKFRAME` border, not a gap.

**No layout work was needed, and that is the point.** The renderer was
already built for widths far below what the window would allow:

| Breakpoint | Where | What happens below it |
|---|---|---|
| `STACK_BREAKPOINT` 1100 | `useSplitPane.ts:27` | notice and reply stop being side-by-side and stack |
| `RAIL_BREAKPOINT` 760 | `App.tsx:43` | the 240px rail becomes a top bar with a sessions disclosure |

At a half-snap the renderer sees 768 CSS px: above 760, so the rail stays;
below 1100, so the panes stack. Both paths already existed and neither had
ever been reachable, because 860 sat 100px above the rail breakpoint. The
window minimum, not the layout, was the whole bug.

Pinned by `lib.rs::tests::the_window_can_be_narrowed_enough_to_half_snap_at_125_percent`,
which reads the real `tauri.conf.json` rather than a copy. Mutation-checked:
restoring 860 fails it with the measured 115px figure in the message.

## The app reported its own backend down while the backend was up

The longest-running bug in the rebuild, and nothing in the stack said so.

The symptom was total and consistent: the rail read "Not running", Settings
read "The backend is not running", the draft pane read "The model server
isn't running", and the Draft button was disabled -- while
`curl http://127.0.0.1:8000/health` returned 200 on every attempt and
`frontend.log` recorded `backend ready on :8000` at every launch.

Ruled out first, all correct and none the cause: `getHealth()` and
`apiFetch` in `src/lib/api.ts`; the `getBackendPort` chain through
`bridge.ts` to the Rust `get_backend_port`; `port-rs.txt`; `is_packaged()`
(`!cfg!(debug_assertions)`, so a `--release` build does take the spawn
branch); and both CSPs, which allow `127.0.0.1:8000` in the object form and
in `index.html`'s `<meta http-equiv>` alike.

**What found it** was giving up on inference and reading the renderer's own
error: the offline message was temporarily replaced with the caught value
interpolated into a `DIAG:` string, rebuilt, and read off a screenshot. It
said `TypeError: Failed to fetch` -- a network-layer rejection, before any
status exists.

**The cause was CORS.** `backend-rs/src/middleware.rs`'s `allowed_origins()`
listed `tauri://localhost` and `https://tauri.localhost`. Windows WebView2
uses neither: it sends `http://tauri.localhost`. Confirmed by hand --

```
curl -i -H "Origin: http://tauri.localhost" http://127.0.0.1:8000/health
```

returns 200 with `vary: origin` and **no `access-control-allow-origin`**,
while the other two spellings get the header.

All three spellings are allowed now, with a comment saying why the test
suite could not have caught it: **curl does not enforce CORS.** Every
command-line probe passes against a backend no browser can reach. Pinned by
`middleware::tests::every_tauri_origin_spelling_is_allowed` (backend-rs:
144 tests).

### The second bug the outage left behind

`DraftWorkspace` held its own `modelServerReady` state, seeded by a single
`getHealth()` in a mount-only effect. It caught the outage, latched `false`,
and had no path back -- so after the CORS fix the rail said Ready while the
draft footer still said the model server was down and kept the button
disabled.

It is a prop now, fed from `App.tsx` as
`backend.kind === "online" && backend.health.ollama_running`: the same poll
the rail reads, so the two cannot disagree. **Any second poller against an
endpoint the shell already polls is this bug waiting to happen.**

## A mutation with no Origin header bypassed authentication

Found 17 Oct 2026 by running the API, not by reading it. Fixed in
`backend-rs/src/middleware.rs`, `local_origin_guard`.

The token check sat **inside** `if let Some(origin) = ...`. A mutating
request that sent no `Origin` header at all therefore skipped
authentication completely:

```
POST /generate   (no Origin, no X-ITax-Auth)  ->  200, real inference
```

Browsers always send `Origin` on a cross-origin request, so the browser
threat model looked covered. But **curl, PowerShell's `Invoke-WebRequest`,
and every other non-browser local process omit `Origin` by default** -- and
so reached `/generate`, `/upload`, `/save-docx`, `/rag/sync` and
`/rag/reindex` with no credential. The guard's own doc comment claimed
"token-or-trusted-origin for mutations", which is the behaviour it now
actually has.

The rule is inverted: a mutation needs a trusted origin **or** a valid
token, and an absent Origin is simply not a trusted origin.

### Why the existing tests missed it

Every guard test asserted over the **lists** -- `allowed_origins()` and
`trusted_browser_origins()` -- and not one sent a request through the
middleware. The lists were all correct. The code that consulted them was
not. `a_mutation_without_an_origin_still_needs_a_token` drives the real
`local_origin_guard` through `tower::ServiceExt::oneshot` and covers the
four cases that define the contract:

| Origin | Token | Expected |
|---|---|---|
| absent | absent | **403** -- the regression |
| absent | valid | 200 -- curl, scripts, the packaged app |
| untrusted | absent | 403 |
| trusted (`localhost:5174`) | absent | 200 -- the dev server |

Confirmed to fail against the pre-fix code and pass against the fix, which
is the only thing that makes a regression test worth keeping.

**Any future edit to this guard must keep a test that drives the
middleware.** A list-shaped assertion cannot see this class of bug.

## Nothing may read `window.localAgent` on mount without awaiting the bridge

`main.tsx` installs the bridge inside `Root`'s effect. React runs a child's
effect before its parent's, so **any component that reads
`window.localAgent` from its own mount effect can lose that race** -- and
two did:

- `SessionList` lost it on **every launch**. The rail rendered "Saved drafts
  appear here in the desktop app." inside the desktop app, hiding every
  saved session. It was in each screenshot taken of this build and was read
  as an empty-state design rather than a bug.
- `SettingsView` lost it whenever the dialog was open as the app mounted.
  The panel showed "Settings can only be changed in the desktop app. These
  values are the defaults, not what is stored." with every control disabled.

Both now `await installBridge()` as the first statement of `load()`.
`installBridge()` is idempotent -- it returns immediately once
`window.localAgent` exists -- so this costs nothing once the bridge is up.

**The rule for new code:** read the bridge from a click handler and it is
already installed; read it from a mount effect and you must await
`installBridge()` first. The failure mode is silent and looks like a
designed empty state, which is exactly why it survived this long.
Click-handler callers audited and confirmed safe: `CorpusView`,
`useDraft`, and the model refresh in `App.tsx`.

Found by screenshotting the running window, not by reading code or by
`tsc` -- the types are satisfied either way.

## Settings saves when it closes

User's call, 15 Oct 2026, replacing a discard confirm on Escape and the
scrim.

The concern was raised once and overruled: saving on close removes the
chance to back out, and `save_config` **unconditionally restarts the
backend**, so a stray Escape could kill a draft in progress. The mitigations
are in the panel rather than in a prompt:

- **An unchanged panel is a no-op.** No save, no restart, nothing killed.
  This is what makes a stray Escape harmless in the common case.
- **An invalid panel refuses to close.** The commit resolves `false`, the
  dialog stays open, and the offending field is already marked.
- **A refused save refuses to close too.** `onSave` returns a boolean now --
  it previously swallowed host validation failures into `saveError` and
  returned normally, which under autosave would have closed the dialog and
  thrown the edits away with the reason still on screen behind it.

The panel registers its commit with the host through `onRegisterCommit`,
held in a ref because `onSave` is rebuilt on every render -- registering it
directly would re-run the effect on every keystroke and leave the host
holding a stale closure in between. `onOpenChange` defers the close until
the promise resolves.

The host's copy of the dirty flag is gone (`onDirtyChange` with it): nothing
up there has to decide whether to warn any more. The header indicator is no
longer amber "Unsaved changes" but a plain "Saves when you close" -- a
warning colour for a state with no loss in it is noise.

## Smaller fixes this session

- **The theme control moved out of the rail into Settings** (user's call).
  It was a three-state rotation behind one icon, which took three clicks to
  get from dark to light and spent one of them on System resolving to dark
  -- a click with no visible effect. It is a three-segment control in
  Settings > Windows > Appearance now, applied immediately rather than
  joining the save draft, because the theme is renderer-local
  (`localStorage`) and not part of `AppConfig`. `Sun`, `Moon` and a
  short-lived `SystemTheme` icon are gone.
- **A document scrollbar was painting beside the title bar.** `html, body
  { overflow: hidden }` in `global.css` `@layer base`. Every scrollable
  region here is an inner pane with its own `overflow-y-auto`, so a document
  scrollbar only ever means something overflowed the viewport -- and because
  the custom caption is in the same document, it paints full window height
  next to it, and when maximized it lands in the invisible resize border.
- **The rail does not reach the caption, and should not.** Painting the
  caption's leading 240px in the rail's surface colour was tried and
  rejected on sight: it reads as a tab rather than a continuous sidebar. The
  32px above the rail is the caption's own height. Reverted; `TitleBar` has
  no `railWidth` prop.
- **Copy**: "Failed to fetch" no longer leads a draft error -- `fetch` says
  it for every network refusal and it tells the user nothing, so the written
  sentence leads and the browser's goes in the action line. The empty draft
  pane's heading is `Draft`, not `Reply`, matching the button, the status
  and the filled pane. The offline message no longer says "use Retry" with
  the Retry button directly beneath it. The 400/422 branch has an action
  line like every other branch.

## Traps

- **A missing Tauri capability is silent.** Not a build error, not a panic,
  not a log line -- the IPC call is rejected and the control does nothing.
  `tsc`, `cargo build` and every unit test pass. It can only be caught by
  running the packaged app or by asserting the permission list, which
  `lib.rs` now does. Worth knowing that the command names do not map one to
  one onto the API: `toggleMaximize()` needs `toggle-maximize`, which
  `maximize` + `unmaximize` does **not** imply, and a `data-tauri-drag-region`
  double-click needs `internal-toggle-maximize`, which no renderer code
  mentions.
- A `{/* */}` JSX comment directly inside an `&&` branch is a syntax error
  that `tsc --noEmit` passes and only `vite build` catches. Run the build
  before any release gate, not just typecheck.
- `public/fonts/*.woff2` are referenced and **deliberately absent**. Vite
  warns about four unresolved refs; that is intended graceful degradation to
  Georgia / Segoe UI / Consolas, not a defect. A placeholder binary would
  fail to parse and fall back identically, so it buys nothing.
- No test runner is wired in `frontend-v2/package.json`. The citation suites
  ran as throwaway Node scripts. Making them permanent is a dependency
  change, so it was left as the user's call.
- ~~`installer/installer.nsh` needs porting.~~ **Written**, as
  `src-tauri/installer.nsh`, and wired via `bundle.windows.nsis.installerHooks`.
  Deliberately **not** a port: ~500 of v1's 655 lines exist to install Ollama
  and pull two ~9 GB models, and its config page collects three keys v2 does
  not have, so copying it would have written a config v2 cannot read. v2's is
  ~180 lines and does three things: stop a running instance before the copy,
  seed `config-rs.json` **only when absent** (overwriting it would destroy
  the user's Indian Kanoon token, possibly their only copy), and offer a
  double-confirmed data wipe on uninstall that defaults to keeping. It
  downloads nothing and asks for no token.

  **Built and verified**: 9.12 MiB, `makensis` clean, and the archive listed
  rather than assumed — both binaries present, `backend-rs.exe` timestamped
  after the port fix, with the `nsDialogs`/`nsExec` plugins the hook needs.
  Being a third copy of the config defaults, it is pinned by
  `config::tests::the_installer_seeds_every_key_the_host_knows`, which parses
  the .nsh and fails on drift in either direction — mutation-checked by
  dropping a key and watching it fail with the fix named.
  **Never run it on this machine** — the gate verifies the artifact builds,
  not that it installs.
- **`src-tauri/target/release/backend-rs.exe` is a stale copy.** The NSIS
  bundle maps the real path (`../../backend-rs/target/release/backend-rs.exe`),
  but a direct run of the built app uses this copy and nothing refreshes it
  -- it was 49 minutes behind once, which reads as a backend that ignores
  its own fixes. Re-copy after every `backend-rs` rebuild, before any launch
  test.
- **`extendTailwindMerge` has to be told about every key added to
  `theme.extend`.** `cn.ts` lists `max-w-measure`, both durations and
  `ease-ledger`. A key twMerge does not know is not treated as conflicting,
  so both classes survive and stylesheet order decides -- `DialogContent`'s
  `max-w-measure` beat the Settings panel's `max-w-[64rem]` exactly this
  way.
- **The spacing scale is a replacement, so `h-5` emits nothing.** There is
  no `5` rung (`0, px, 1, 2, 3, 4, 6, 8, 12, 16, 24`). Same class as
  `gap-10`; only a diff of source tokens against the built stylesheet
  catches it.
- **Do not animate a centred dialog with `pop-in`.** It animates `transform`,
  which wipes the `translate(-50%,-50%)` that centres the surface, so it
  flies in from the corner. `dialog-in` exists for this.
- Nothing is committed yet. Correct per the commit policy: this lands as one
  commit once verification and the action report are done. The critique
  passes have run.

## The six-step pass, 16 Oct 2026

Run over `frontend-v2` and `backend-rs` only; v1 `frontend/` and `backend/`
were out of scope and untouched. Three loops of steps 1-4.

Fixed across the three loops: a CORS change that had silently granted the
packaged Tauri origin token-free **write** access (the trusted-origin list
was literally the CORS list); an unbounded zip-entry read in the DOCX parser
(the upload cap bounds compressed bytes, deflate on repetitive XML exceeds
1000:1); an unvalidated remote `docid` interpolated into URL paths; a config
`save()` that whole-file-overwrote a file the 16-field host struct also owns,
erasing two of its keys on the fallback-port path; an O(N*M) HashSet rebuild
in the ingest loop; and five CSP directives present in the `index.html` meta
tag but missing from `tauri.conf.json`.

**Verifying an embedded CSP by grepping the exe does not work.** Tauri
interns the directive key strings, so `default-src`, `img-src` and
`connect-src` return zero literal hits in the built binary while being
unquestionably active -- their *values* are plainly present. A substring scan
reads as "the directives were dropped" and is wrong. `Csp` in `tauri-utils`
is `DirectiveMap(HashMap<String, _>)`, an open map with no key allowlist, so
anything added to the config is carried through. Check the config and the
deserializer, not the binary.

Gate state at the end: backend-rs 152 tests, src-tauri 34, clippy **zero
warnings on both crates**, `tsc --noEmit` clean, `vite build` clean (478.34
kB / 151.39 kB gzip), `npm audit --omit=dev` 0 vulnerabilities. Artifacts
rebuilt in the required order (`vite build` -> backend-rs `cargo build
--release` -> re-copy `backend-rs.exe` -> src-tauri `cargo build --release`)
and launch-verified: backend healthy on :8000 in 12s, no orphan after
shutdown.

Raised once, deliberately not taken: 7 npm audit findings, all in Tailwind
3's build-time toolchain, none shipping in the bundle. The fix is Tailwind 4,
a breaking change to an already-approved design system.
