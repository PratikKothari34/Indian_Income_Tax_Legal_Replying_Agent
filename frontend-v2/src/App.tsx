/**
 * The app shell: the rail, the route switch, the theme toggle, and the backend
 * status indicator.
 *
 * No router dependency. There are two screens, no URLs to share, and a
 * packaged `file://` renderer where history-based routing is a liability — so
 * the "route" is a piece of local state.
 *
 * Settings is **not** a screen. It is a dialog off a small button beside the
 * theme toggle: it is somewhere you go to change one thing and leave, not a
 * place you work, and as a third nav item it sat permanently alongside the
 * two screens that are actually the app.
 *
 * The rail is 240px per the layout diagram and becomes a top bar under 760px.
 * That breakpoint is read in JS rather than expressed purely in CSS because the
 * two layouts need different DOM order, not just different styles: in the rail
 * the session list sits below a rule, and in the top bar it collapses behind a
 * disclosure so it does not eat vertical space on a short window.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import type { Citation } from "@/lib/citations";

import {
  Button,
  DialogClose,
  DialogContent,
  DialogRoot,
  DialogTitle,
  IconButton,
  Tooltip,
  cn,
  useToast
} from "@/components/ui";
import {
  ChevronDown,
  Corpus as CorpusIcon,
  Draft as DraftIcon,
  Settings as SettingsIcon,
  X
} from "@/components/icons";
import CorpusView from "@/components/app/CorpusView";
import DraftWorkspace from "@/components/app/DraftWorkspace";
import SessionList from "@/components/app/SessionList";
import SettingsView from "@/components/app/SettingsView";
import TitleBar from "@/components/app/TitleBar";
import { getHealth } from "@/lib/api";
import { isTauri, onBackendLifecycle } from "@/lib/bridge";
import type { HealthResponse } from "@/types/api";

type Screen = "draft" | "corpus";
export type Theme = "light" | "dark" | "system";

const THEME_KEY = "ledger.theme";
const RAIL_BREAKPOINT = 760;

// The rail's width, as a constant so the layout and any future caller agree.
const RAIL_WIDTH = 240;
/** Health polling. Slow once online; the lifecycle event covers the fast path. */
const HEALTH_POLL_ONLINE_MS = 30_000;
const HEALTH_POLL_OFFLINE_MS = 5_000;

const NAV: {
  screen: Screen;
  label: string;
  Icon: (p: { className?: string }) => ReactElement;
}[] = [
  { screen: "draft", label: "Draft", Icon: DraftIcon },
  { screen: "corpus", label: "Corpus", Icon: CorpusIcon }
];

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    /* storage unavailable — follow the OS */
  }
  return "system";
}

/**
 * `tokens.css` keys off `data-theme`, so applying a theme is one attribute
 * write. "system" removes the attribute entirely rather than setting
 * `data-theme="system"`, because the `prefers-color-scheme` block is guarded
 * with `:root:not([data-theme="light"])` and expects the attribute absent.
 */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* the choice holds for this session only */
  }
}

// ---------------------------------------------------------------------------
// Backend status
// ---------------------------------------------------------------------------

type BackendState =
  | { kind: "starting" }
  | { kind: "online"; health: HealthResponse }
  | { kind: "degraded"; health: HealthResponse }
  | { kind: "offline"; message: string };

/// The tone for a state worth showing, or `null` when there is nothing to
/// say. A healthy backend returns `null` and the whole status block is
/// omitted: "Ready" told the user only that the thing they are already using
/// works. What remains is exceptional by construction, so it reads as a
/// problem the moment it appears.
function statusTone(state: BackendState): {
  dot: string;
  text: string;
  label: string;
  /// Absent when the label already says everything actionable.
  detail?: string;
} | null {
  switch (state.kind) {
    case "starting":
      return {
        dot: "bg-ink-faint",
        text: "text-ink-muted",
        label: "Starting",
        detail: "The backend is still coming up. A cold start takes about half a minute."
      };
    case "online":
      // Nothing. Not a word, not a marker. The healthy state is the one the
      // user is looking at anyway; saying so occupied the most persistent
      // slot in the window to confirm what the working app already proves.
      // Every other case stays, because each tells you something you cannot
      // otherwise know -- how long to wait, what file is missing, why
      // nothing is listening.
      return null;
    case "degraded":
      return {
        dot: "bg-amber",
        text: "text-amber",
        label: "No model",
        // `ollama_running` keeps its v1 name on the wire for compatibility;
        // it means "the model server answered". For v2 that server is
        // llama-server, and a missing model is a missing .gguf file.
        detail: state.health.ollama_running
          ? `Neither ${state.health.primary_model} nor ${state.health.fallback_model} could be loaded. Set a model file in Settings, then check again.`
          : "The model server isn't running. Start it, then check again."
      };
    case "offline":
      return {
        dot: "bg-vermilion",
        text: "text-vermilion",
        label: "Not running",
        detail: state.message
      };
  }
}

export default function App() {
  const toast = useToast();

  const [screen, setScreen] = useState<Screen>("draft");
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && window.innerWidth < RAIL_BREAKPOINT
  );
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Supplied by the panel; commits its draft. See `registerSettingsCommit`.
  //
  // There is no host copy of the panel's dirty flag any more: closing saves
  // rather than discards, so nothing up here has to decide whether to warn.
  const commitSettings = useRef<(() => Promise<boolean>) | null>(null);
  // True while a close-commit is in flight. Escape repeats while a key is
  // held and the scrim takes a click per press, so without this a slow save
  // can be started several times over -- each one restarting the backend.
  const committingSettings = useRef(false);
  const registerSettingsCommit = useCallback(
    (commit: (() => Promise<boolean>) | null) => {
      commitSettings.current = commit;
    },
    []
  );
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // Set when a verified margin tag is clicked; consumed by CorpusView to seed
  // its filter. Held here because the two views are siblings.
  const [focusCitation, setFocusCitation] = useState<Citation | null>(null);
  const [backend, setBackend] = useState<BackendState>({ kind: "starting" });
  const [checking, setChecking] = useState(false);

  // The inline script in index.html set the attribute pre-paint; this keeps it
  // in step once React owns the value.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // What the window actually looks like right now, which under "system" is
  // not the same as `theme`. The toggle's tooltip needs it: "Following the
  // system" alone does not tell the user whether that currently means light
  // or dark, and the icon for system is deliberately neither.
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent | MediaQueryList) =>
      setSystemDark(event.matches);
    onChange(query);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Rail vs top bar.
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${RAIL_BREAKPOINT - 1}px)`);
    const onChange = (event: MediaQueryListEvent | MediaQueryList) => {
      setCompact(event.matches);
      if (!event.matches) {
        // Leaving compact: the disclosure state is meaningless in the rail.
        setSessionsOpen(false);
      }
    };
    onChange(query);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // --- health ---------------------------------------------------------------

  const check = useCallback(async () => {
    try {
      const health = await getHealth();
      setBackend(health.status === "ok" ? { kind: "online", health } : { kind: "degraded", health });
      return true;
    } catch {
      setBackend({
        kind: "offline",
        message: isTauri()
          // No "use Retry": the Retry button is rendered directly beneath
          // this sentence, and naming a control the user is already looking
          // at spends a line saying nothing.
          ? "The backend isn't answering. Check the port in Settings."
          // No shell command here. The user is a tax professional running
          // a packaged app: they have no source tree, no Rust toolchain, and
          // nothing to type a cargo invocation into. The host starts the
          // backend, so a restart is the action that actually fixes this.
          : "The backend isn't running. Close the app and open it again."
      });
      return false;
    }
  }, []);

  // Keep the poll cadence out of the effect's identity: polling every 5 s while
  // offline surfaces a recovery quickly, but once online a 30 s heartbeat is
  // plenty and a packaged cold start should not be hammered.
  const backendKindRef = useRef(backend.kind);
  backendKindRef.current = backend.kind;
  const online = backend.kind === "online" || backend.kind === "degraded";

  useEffect(() => {
    void check();
    const interval = window.setInterval(
      () => void check(),
      online ? HEALTH_POLL_ONLINE_MS : HEALTH_POLL_OFFLINE_MS
    );
    return () => window.clearInterval(interval);
  }, [check, online]);

  // The host knows the real outcome long before a poll would: it is the process
  // that spawned backend.exe. Trust the event over the poll.
  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      const unsubscribe = await onBackendLifecycle({
        onReady: () => {
          void check();
        },
        onFailed: (message) => {
          setBackend({
            kind: "offline",
            message: message || "The backend could not be started. Check the logs folder in Settings."
          });
        }
      });
      if (cancelled) {
        unsubscribe();
        return;
      }
      off = unsubscribe;
    })();

    return () => {
      cancelled = true;
      off?.();
    };
  }, [check]);

  const onRetry = async () => {
    setChecking(true);
    setBackend({ kind: "starting" });
    try {
      const retry = window.localAgent?.retryBackend;
      if (retry) {
        const result = await retry();
        if (!result?.success) {
          toast.show({
            tone: "error",
            title: "The backend did not restart",
            body: result?.error ?? "Check the logs folder in Settings."
          });
        }
      }
      await check();
    } finally {
      setChecking(false);
    }
  };

  const tone = statusTone(backend);

  const onSelectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setScreen("draft");
    if (compact) {
      setSessionsOpen(false);
    }
  };

  const nav = (
    <nav aria-label="Screens" className={cn(compact ? "flex gap-1" : "flex flex-col gap-px px-2")}>
      {NAV.map(({ screen: target, label, Icon }) => {
        const active = screen === target;
        return (
          <button
            key={target}
            type="button"
            onClick={() => setScreen(target)}
            // aria-current="page" is the one accessible signal that a nav item
            // is the item you are looking at; the seal wash is its visual peer.
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-control px-3 py-2 text-sm",
              "outline-none focus-visible:ring-2 focus-visible:ring-seal focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
              active
                ? "bg-seal-wash font-medium text-seal"
                : "text-ink-muted hover:bg-sunken hover:text-ink"
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        );
      })}
    </nav>
  );

  const settingsButton = (
    <Tooltip content="Settings">
      <IconButton
        aria-label="Open settings"
        variant="ghost"
        // `md`, not `sm`: the sm size pins the glyph to 12px via
        // [&_svg]:h-3, which overrides any class on the icon itself, and a
        // 12px gear in a 24px button read as a speck. md is 32x32 with a
        // 16px glyph -- also the WCAG 2.5.8 target-size floor.
        size="md"
        onClick={() => setSettingsOpen(true)}
      >
        <SettingsIcon />
      </IconButton>
    </Tooltip>
  );

  const settingsDialog = (
    <DialogRoot
      open={settingsOpen}
      onOpenChange={(next) => {
        // Closing saves. Escape, the scrim and the X all land here, and all
        // three commit rather than discard -- a settings panel that throws
        // away what was typed because the wrong key was pressed is the more
        // expensive mistake.
        //
        // The panel decides whether there is anything to do: an unchanged
        // panel is a no-op, because saving restarts the backend and would
        // kill a draft in progress for nothing. An invalid panel resolves
        // false and the dialog stays open, with the offending field already
        // marked -- closing would either save a bad value or silently drop
        // a good one.
        if (!next) {
          if (committingSettings.current) {
            return;
          }
          const commit = commitSettings.current;
          if (commit) {
            committingSettings.current = true;
            void commit()
              .then((closed) => {
                if (closed) {
                  setSettingsOpen(false);
                }
              })
              .finally(() => {
                committingSettings.current = false;
              });
            return;
          }
        }
        setSettingsOpen(next);
      }}
    >
      {/* Wider than the default dialog: this is a full panel, not a confirm.
          64rem (1024px) is sized to the panel's own split -- a 13rem category
          sidebar, then a right pane holding a 16rem label column and its
          control, with the gap between them. Narrower and the label column
          hits its floor and the rows stack, which is the layout the sidebar
          was meant to replace.

          `DialogContent`'s own `max-w-measure` has to lose to this, which it
          only does because `cn` is told `measure` is a max-width key. Without
          that the two classes both survive and the stylesheet's order decides
          -- see `cn.ts`.

          `h-[85vh]` matches the base `max-h-[85vh]` so the panel always gets
          the full height its own sticky header and scrolling body expect,
          and `overflow-hidden` hands the scrolling to the panel rather than
          letting the dialog scroll its header out of view. */}
      {/* `showClose={false}`: the built-in X is absolutely positioned at the
          dialog's top right, which is exactly where this panel puts its Save
          button. The panel takes a close control in its header row instead,
          via `headerEnd` below. */}
      <DialogContent
        showClose={false}
        className="h-[85vh] max-w-[64rem] gap-0 overflow-hidden p-0"
      >
        {/* The panel draws its own visible heading. This is the dialog's
            accessible name, which Radix requires and would warn about. */}
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <SettingsView
          // Health comes from the shell's existing poll rather than a second
          // one against the same endpoint: two pollers would disagree for up
          // to 30s and show the rail and the panel reporting different
          // states.
          health={
            backend.kind === "online" || backend.kind === "degraded"
              ? backend.health
              : null
          }
          backendOffline={backend.kind === "offline"}
          onRecheck={check}
          // Theme is renderer-local (localStorage), not part of AppConfig, so
          // it is passed in and applies immediately rather than joining the
          // draft that Save writes to the backend.
          theme={theme}
          onThemeChange={setTheme}
          systemDark={systemDark}
          onRegisterCommit={registerSettingsCommit}
          headerEnd={
            // `DialogClose` runs the same `onOpenChange` as Escape and the
            // scrim, so the save-on-close above covers this too.
            <DialogClose asChild>
              <IconButton aria-label="Close settings" variant="ghost" size="md">
                <X />
              </IconButton>
            </DialogClose>
          }
        />
      </DialogContent>
    </DialogRoot>
  );

  // Null while the backend is healthy, so the sidebar ends at the nav and
  // the rule above the status goes with it. The live region lives one level
  // up, in `statusRegion`, so that an appearing block is still announced --
  // a region that is itself conditionally mounted announces nothing.
  const status = tone && (
    <div className={cn("px-4 py-3", !compact && "border-t border-rule")}>
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", tone.dot)} aria-hidden="true" />
        <span className={cn("text-xs", tone.text)}>{tone.label}</span>
        {/* In compact layout the detail sentence is not rendered, which would
            leave the announcement as a bare "No model" with nothing about
            what to do. It stays in the live region either way. */}
        {compact && tone.detail && <span className="sr-only">{tone.detail}</span>}
      </div>
      {!compact && tone.detail && (
        <p className="mt-1 text-xs text-ink-faint">{tone.detail}</p>
      )}
      {(backend.kind === "offline" || backend.kind === "degraded") && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => void onRetry()}
          disabled={checking}
        >
          {/* One verb for one action. It was "Retry" when offline and
              "Check again" when degraded -- the same button, the same
              request, two names depending on which failure you hit. */}
          {checking ? "Checking" : "Check again"}
        </Button>
      )}
    </div>
  );

  // The always-mounted wrapper. Polite, not assertive: a backend coming up is
  // not worth interrupting a sentence being typed into the notice pane.
  const statusRegion = <div aria-live="polite">{status}</div>;

  return (
    // Two rows: the caption, then everything that was the app. The caption
    // renders nothing outside Tauri, so in `dev:web` this collapses to the
    // original single-child layout.
    <div className="flex h-full min-h-0 flex-col">
      <TitleBar title="Income Tax Legal Reply Agent" />
      {settingsDialog}

      <div className={cn("flex min-h-0 flex-1", compact ? "flex-col" : "flex-row")}>
        <a href="#main" className="skip-link bg-surface px-3 py-2 text-sm text-seal">
          Skip to content
        </a>

        {compact ? (
          <header className="shrink-0 border-b border-rule bg-surface">
            <div className="flex items-center justify-between gap-2 px-4 py-2">
              {nav}
              <div className="flex items-center gap-1">
                {/* Only when something is wrong. A dot that is always lit
                    is chrome; one that appears is a signal.

                    The wrapper is mounted unconditionally even though it is
                    usually empty: a live region only announces changes made
                    while it is ALREADY in the DOM. Putting the region on the
                    dot itself meant the region and its content appeared in
                    the same tick, so the backend going down was announced to
                    nobody. Same rule as `statusRegion` in the rail. */}
                <span aria-live="polite" className="contents">
                  {tone && (
                    <span
                      className={cn("h-2 w-2 shrink-0 rounded-full", tone.dot)}
                      role="img"
                      aria-label={`Backend: ${tone.label}`}
                    />
                  )}
                </span>
                {settingsButton}
                {/* md to match the gear beside it; the sm size would pin
                    this glyph to 12px regardless of the class below. */}
                <IconButton
                  aria-label={sessionsOpen ? "Hide sessions" : "Show sessions"}
                  variant="ghost"
                  size="md"
                  aria-expanded={sessionsOpen}
                  onClick={() => setSessionsOpen((open) => !open)}
                >
                  <ChevronDown
                    className={cn("transition-transform duration-120", sessionsOpen && "rotate-180")}
                  />
                </IconButton>
              </div>
            </div>
            {sessionsOpen && (
              <div
                // Arbitrary value: the spacing scale is replaced and stops at
                // 24 (6rem), so there is no step for "about a third of a short
                // window". The session list scrolls inside this cap.
                className="max-h-[16rem] overflow-hidden border-t border-rule"
              >
                <SessionList
                  activeSessionId={activeSessionId}
                  onSelect={onSelectSession}
                  onDeleted={(id) => {
                    if (id === activeSessionId) {
                      setActiveSessionId(null);
                    }
                  }}
                  className="py-2"
                />
              </div>
            )}
          </header>
        ) : (
          <aside
            // Fixed width (see RAIL_WIDTH). shrink-0 so a wide reply pane
            // cannot squeeze the rail.
            className="flex shrink-0 flex-col border-r border-rule bg-surface"
            style={{ width: RAIL_WIDTH }}
          >
            <div className="flex items-center justify-between gap-2 px-4 py-4">
              <div>
                {/* The product name, matching the window caption. "Ledger"
                    is the design system (docs/DESIGN.md), an internal name
                    the user has no reason to see. */}
                <p className="text-sm font-semibold text-ink">Income Tax Reply</p>
                <p className="text-xs text-ink-faint">Draft replies to notices</p>
              </div>
              <div className="flex items-center gap-1">
                {settingsButton}
              </div>
            </div>

            {nav}

            {/* The rule the layout diagram puts above the session list. */}
            <div className="mt-4 min-h-0 flex-1 border-t border-rule pt-3">
              <SessionList
                activeSessionId={activeSessionId}
                onSelect={onSelectSession}
                onDeleted={(id) => {
                  if (id === activeSessionId) {
                    setActiveSessionId(null);
                  }
                }}
                className="h-full"
              />
            </div>

            {statusRegion}
          </aside>
        )}

        <main id="main" className="min-h-0 min-w-0 flex-1">
          {screen === "draft" && (
            <DraftWorkspace
              onOpenCitation={(citation) => {
                setFocusCitation(citation);
                setScreen("corpus");
              }}
              // The same poll the rail reads, so the two cannot disagree.
              modelServerReady={
                backend.kind === "online" && backend.health.ollama_running
              }
            />
          )}
          {screen === "corpus" && <CorpusView focusCitation={focusCitation} />}
        </main>
      </div>
    </div>
  );
}
