/**
 * Settings.
 *
 * ## What belongs here
 *
 * The panel is for a chartered accountant replying to a notice, not for
 * whoever packaged the app. A control earns its place by being something that
 * user could reasonably want to change; everything else is either a hidden
 * default or, if it does nothing, deleted outright.
 *
 * Four controls were removed rather than rearranged, and they are worth
 * naming so nobody restores them:
 *
 * - **Keep in the system tray** and **Keep awake while drafting** were
 *   switches wired to nothing. No tray icon is ever constructed and nothing
 *   calls `SetThreadExecutionState`; the tray switch in particular promised
 *   the opposite of what closing the window actually does. The keys are still
 *   persisted by the host, so re-adding the UI once the behaviour exists is a
 *   small change — but a switch that lies is worse than a missing feature.
 * - **Backend port** could brick the install. The renderer reaches the
 *   backend over `fetch`, and the CSP in `tauri.conf.json` allows exactly
 *   `127.0.0.1:8000`–`8003`. A backend moved to 9000 starts and answers
 *   normally while the renderer is blocked from ever reaching it — including
 *   this panel, the only in-app way to put it back. The host now rejects any
 *   port outside that set; the field is gone.
 * - **Read PDFs from incometaxindia.gov.in** was worse than dead: enabling it
 *   only pushed an error string into the sync report, and its description
 *   ("Turn this off to sync from Indian Kanoon only") was false in both
 *   positions.
 *
 * The model-server path, host and port left too. They describe how the app
 * runs llama.cpp, which is the app's business; a wrong value there breaks
 * drafting with no way for the user to tell why.
 *
 * ## The Indian Kanoon token
 *
 * `get_config` never returns the real token — it returns `mask_token(stored)`:
 * `""` when unset, `"********"` at 8 chars or fewer, else `first4 + "****" +
 * last4`. `save_config` compares the incoming value against that same mask
 * and, when they are equal, keeps the real stored token.
 *
 * So the renderer's job is narrow and absolute: **render the mask, send the
 * mask back byte-identical unless the user typed over it.** Two consequences
 * drive the code below:
 *
 * 1. The field is seeded from the masked config and never normalised — no
 *    trim, no case fold, no placeholder substitution. A trim would turn an
 *    unedited field into an "edit" and write the mask over the live token,
 *    destroying the only copy.
 * 2. The token is excluded from the patch entirely when it still equals the
 *    value the host handed us. Not sending the key is safer than sending a
 *    mask the host has to recognise, because it cannot be mistaken even if
 *    the host's mask function ever changes.
 *
 * It is never logged, never interpolated into an error message, and never put
 * in a toast description.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Button,
  Field,
  Panel,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SegmentedControl,
  Slider,
  Spinner,
  Switch,
  TextInput,
  TimeDial,
  cn,
  focusRingOnSurface,
  useToast
} from "@/components/ui";
import {
  Alert,
  Check,
  Clock,
  Corpus,
  Draft,
  Folder,
  Settings,
  Windows
} from "@/components/icons";
import {
  DEFAULT_SCHEDULE,
  cronToSchedule,
  describeCron,
  formatTimeOfDay,
  isValidCron,
  scheduleToCron
} from "@/lib/format";
import { installBridge } from "@/lib/bridge";
import { pickFile } from "@/lib/pickFile";
import type { AppConfig, HealthResponse } from "@/types/api";
import type { Theme } from "@/App";

/**
 * The three appearance settings.
 *
 * All three are spelled out, which is the reason this lives here and not in
 * a rail icon: the icon had to cycle through them, and "Follow the system"
 * in the middle of that rotation was a click that changed nothing visible
 * whenever the system already matched. Three labelled choices, pick one.
 */
const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" }
];

/**
 * Must match `src-tauri/src/config.rs::AppConfig::default` — v2's own host,
 * not v1's `backend/paths.py::DEFAULT_CONFIG`, which is a different product
 * with a different key set. Only used to render the form before the host
 * answers, and in the browser dev run where there is no host at all — never
 * saved on its own.
 *
 * A default that disagrees with the host's is not cosmetic: the form renders
 * this value, the user saves without touching the field, and the disagreeing
 * value is written over the host's real one.
 */
const FALLBACK_CONFIG: AppConfig = {
  llama_host: "127.0.0.1",
  llama_port: 8080,
  llama_server_path: "",
  llama_model_path: "",
  llama_fallback_model_path: "",
  llama_ctx_size: 8192,
  llama_gpu_layers: 999,
  backend_port: 8000,
  indiankanoon_token: "",
  incometax_pdf_scraper_enabled: false,
  rag_sync_schedule: "0 12 * * *",
  run_at_startup: false,
  system_tray: true,
  keep_awake: true,
  default_temperature: 0.2,
  always_save_docx: true
};

/**
 * The schedule picker's options.
 *
 * Frequency alone is not a schedule -- "every week" does not say which day,
 * and nothing said at what time. So the frequency select is paired with the
 * detail that frequency implies, and a time field in every case. Three small
 * controls instead of a preset list, because a preset list that covered
 * weekday x hour would run to 168 entries.
 */
const FREQUENCIES = [
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" }
] as const;

/**
 * The four categories, in the order the sidebar lists them.
 *
 * Ordered by how often a user touches them, not by importance: the model
 * path is the first thing to get wrong on a new install and the first thing
 * to change when a better model arrives, so Drafting leads. Advanced is last
 * because nothing there should be touched by default.
 *
 * This is a sidebar rather than one scrolling page (user's call, 15 Oct
 * 2026). The trade it makes is real and worth knowing before anyone
 * "simplifies" it back: Model file and Layers on the GPU fail together --
 * an out-of-memory error implicates both -- and they now sit on different
 * pages. The hint on each one names the other.
 */
const CATEGORIES = [
  {
    id: "drafting",
    label: "Drafting",
    icon: Draft,
    description: "Which model writes the reply, and how it behaves by default."
  },
  {
    id: "corpus",
    label: "Case law",
    icon: Corpus,
    description: "A local index of judgments and circulars the replies cite from."
  },
  {
    id: "windows",
    label: "Windows",
    icon: Windows,
    description: "How the app behaves on this machine."
  },
  {
    id: "advanced",
    label: "Advanced",
    icon: Settings,
    description:
      "Everything here already has a working default. A wrong value breaks drafting in a way the error messages cannot fully explain."
  }
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

const WEEKDAYS = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" }
] as const;

type Draft = AppConfig & {
  /**
   * Numeric fields are text while being edited so a cleared field is not
   * coerced to 0 — which for a context size would silently mean "no context".
   */
  llama_ctx_size_text: string;
  llama_gpu_layers_text: string;
};

function toDraft(config: AppConfig): Draft {
  return {
    ...config,
    llama_ctx_size_text: String(config.llama_ctx_size),
    llama_gpu_layers_text: String(config.llama_gpu_layers)
  };
}

/** Shared by the context-size and GPU-layer fields. */
function wholeNumberError(
  text: string,
  min: number,
  max: number
): string | null {
  if (text.trim() === "") {
    return "Enter a number.";
  }
  if (!/^\d+$/.test(text.trim())) {
    return "This is a whole number.";
  }
  const value = Number(text.trim());
  if (value < min || value > max) {
    return `Use a value between ${min} and ${max}.`;
  }
  return null;
}

/**
 * A `.gguf` path is only checked for shape, never for existence: the renderer
 * cannot stat a file, and the backend reports a missing model clearly enough.
 * The one case worth catching early is a path to the wrong kind of file,
 * because that failure surfaces much later as a model-load error.
 */
function modelPathWarning(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === "") {
    return null;
  }
  if (!/\.gguf$/i.test(trimmed)) {
    return "This does not look like a .gguf file.";
  }
  return null;
}

export type SettingsViewProps = {
  /**
   * The shell's live health, so the status line agrees with the rail instead
   * of opening a second poll against the same endpoint.
   */
  health: HealthResponse | null;
  /** True while the backend has not answered at all. */
  backendOffline: boolean;
  /** Re-runs the shell's health check. */
  onRecheck: () => void | Promise<unknown>;
  /**
   * Rendered at the end of the header row, beside Save.
   *
   * The host supplies the close control rather than the dialog drawing its
   * own: `DialogContent`'s built-in X is absolutely positioned at the top
   * right, which lands on top of this panel's Save button. Passing it in
   * keeps the panel usable outside a dialog, where there is nothing to
   * close.
   */
  headerEnd?: React.ReactNode;

  /**
   * The appearance setting, and a setter that applies it immediately.
   *
   * Theme is renderer-local -- it lives in localStorage, not in `AppConfig`
   * -- so it deliberately does not join the draft that Save commits. It
   * takes effect on selection, like the toggle it replaced, and leaves the
   * panel undirtied.
   */
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  /** Whether "Follow the system" currently resolves to dark. */
  systemDark: boolean;

  /**
   * Called on mount with a function that commits the panel, and with `null`
   * on unmount.
   *
   * The dialog closes on Escape, the scrim and the X, and all three must
   * save -- but only the panel knows whether anything changed and whether a
   * field is invalid. Handing the host a callback keeps that knowledge here
   * instead of lifting the whole draft up. It resolves `false` when a
   * validation error blocked the save, which is the host's signal to keep
   * the dialog open.
   */
  onRegisterCommit?: (commit: (() => Promise<boolean>) | null) => void;
};

export default function SettingsView({
  health,
  backendOffline,
  onRecheck,
  headerEnd,
  theme,
  onThemeChange,
  systemDark,
  onRegisterCommit
}: SettingsViewProps) {
  const toast = useToast();

  const [saved, setSaved] = useState<AppConfig | null>(null);
  const [draft, setDraft] = useState<Draft>(() => toDraft(FALLBACK_CONFIG));
  const [loading, setLoading] = useState(true);
  const [hostAvailable, setHostAvailable] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [category, setCategory] = useState<CategoryId>("drafting");

  /**
   * The exact masked string the host handed us. Compared byte-for-byte to
   * decide whether the user edited the token field. Held in a ref, not state,
   * so no re-render can stale it between a keystroke and a save.
   */
  const hostMaskedToken = useRef<string>("");

  const load = useCallback(async () => {
    // Await the bridge instead of assuming it is up. main.tsx installs it in
    // an effect, and this panel's effect can run first -- which it does
    // whenever the dialog is open as the app mounts. Reading
    // window.localAgent directly then found nothing and the panel declared
    // itself browser-only, inside the desktop app, with every control
    // disabled. installBridge() is idempotent and returns immediately once
    // installed, so awaiting it costs nothing on the normal path.
    await installBridge();
    const getConfig = window.localAgent?.getConfig;
    if (!getConfig) {
      setHostAvailable(false);
      setLoading(false);
      return;
    }
    try {
      const config = await getConfig();
      hostMaskedToken.current = config.indiankanoon_token;
      setSaved(config);
      setDraft(toDraft(config));
      setHostAvailable(true);
    } catch {
      setHostAvailable(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setJustSaved(false);
    setSaveError(null);
  };

  const ctxSizeError = wholeNumberError(draft.llama_ctx_size_text, 256, 1048576);
  const gpuLayersError = wholeNumberError(draft.llama_gpu_layers_text, 0, 999);
  const cronError = !isValidCron(draft.rag_sync_schedule)
    ? "Five cron fields are needed, like 0 12 * * * for every day at noon."
    : null;

  /**
   * Every validated field lives in Advanced, so one expression answers both
   * "is Save disabled" and "is there an error the user cannot see". They
   * were two identical expressions; a fourth validated field added to one
   * and not the other would disable Save with no way to find out why.
   */
  const advancedHasError = Boolean(ctxSizeError || gpuLayersError || cronError);
  const blocked = advancedHasError;

  /**
   * Every blocking error lives in Advanced. Save is disabled while one is
   * present, so without this the user would see a dead Save button and no
   * explanation -- the field saying why is on a page they are not looking at.
   *
   * Switching once on the transition into error, not on every render while
   * the error persists, so the user can navigate away and read something
   * else without being yanked back.
   */
  const hadAdvancedError = useRef(advancedHasError);
  useEffect(() => {
    if (advancedHasError && !hadAdvancedError.current) {
      setCategory("advanced");
    }
    hadAdvancedError.current = advancedHasError;
  }, [advancedHasError]);

  const tokenEdited = draft.indiankanoon_token !== hostMaskedToken.current;

  const dirty = useMemo(() => {
    if (!saved) {
      return false;
    }
    return (
      draft.llama_model_path !== saved.llama_model_path ||
      draft.llama_fallback_model_path !== saved.llama_fallback_model_path ||
      draft.llama_ctx_size_text.trim() !== String(saved.llama_ctx_size) ||
      draft.llama_gpu_layers_text.trim() !== String(saved.llama_gpu_layers) ||
      draft.default_temperature !== saved.default_temperature ||
      draft.always_save_docx !== saved.always_save_docx ||
      tokenEdited ||
      draft.rag_sync_schedule !== saved.rag_sync_schedule ||
      draft.run_at_startup !== saved.run_at_startup
    );
  }, [draft, saved, tokenEdited]);

  /**
   * Writes the draft. Resolves true only when the settings actually landed.
   *
   * The boolean exists for the close path: a failed save leaves its reason
   * on screen in `saveError`, and the dialog has to stay open to show it.
   */
  const onSave = async (): Promise<boolean> => {
    const saveConfig = window.localAgent?.saveConfig;
    if (!saveConfig) {
      setSaveError("The desktop host is not available, so nothing was saved.");
      return false;
    }
    if (blocked) {
      return false;
    }

    // Only the keys this panel actually offers. Every field the host knows is
    // `unwrap_or(current)`, so an omitted key keeps its stored value — which
    // is what preserves the model-server settings and the two dead desktop
    // flags now that nothing here edits them.
    const patch: Partial<AppConfig> = {
      llama_model_path: draft.llama_model_path.trim(),
      llama_fallback_model_path: draft.llama_fallback_model_path.trim(),
      llama_ctx_size: Number(draft.llama_ctx_size_text.trim()),
      llama_gpu_layers: Number(draft.llama_gpu_layers_text.trim()),
      default_temperature: draft.default_temperature,
      always_save_docx: draft.always_save_docx,
      rag_sync_schedule: draft.rag_sync_schedule.trim(),
      run_at_startup: draft.run_at_startup
    };

    // The token key is present ONLY when the user actually typed over the
    // mask. Omitting it is what preserves the live token; sending the mask
    // back would rely on the host recognising it, and sending an untouched
    // mask is indistinguishable from a user pasting that literal string.
    if (tokenEdited) {
      patch.indiankanoon_token = draft.indiankanoon_token;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const result = await saveConfig(patch);
      if (!result?.success) {
        // `result.error` comes from the host's own validators and never
        // contains the token — the host echoes the config masked.
        setSaveError(result?.error ?? "Those settings could not be saved.");
        return false;
      }

      // Autostart is a Windows Run-key write, applied by a separate command.
      // The tray and keep-awake flags are passed at their stored values
      // because this panel no longer edits them — sending the draft's copy
      // would be the same thing, but reading `saved` makes it explicit that
      // they are pass-through, not settings.
      try {
        await window.localAgent?.applyDesktopSettings?.({
          run_at_startup: draft.run_at_startup,
          system_tray: saved?.system_tray ?? true,
          keep_awake: saved?.keep_awake ?? true
        });
      } catch {
        // `info`, not `error`: the settings themselves did save. Only the
        // Windows-level side effect was refused.
        toast.show({
          tone: "info",
          title: "Settings saved, but Windows did not accept one of them",
          body: "Run at startup may need the app to be launched as administrator once."
        });
      }

      // Re-seed from the host's echo so the mask ref tracks the new token and
      // a second save of an unrelated field does not overwrite it.
      const echoed = result.config;
      if (echoed) {
        hostMaskedToken.current = echoed.indiankanoon_token;
        setSaved(echoed);
        setDraft(toDraft(echoed));
      } else {
        await load();
      }

      setJustSaved(true);
      toast.show({
        tone: "success",
        title: "Settings saved"
      });

      // The backend just restarted, so the health the shell is holding
      // describes a process that no longer exists.
      void onRecheck();
      return true;
    } catch {
      setSaveError("Those settings could not be saved. The desktop host did not respond.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  /**
   * Commit on close, for Escape, the scrim and the X.
   *
   * Held in a ref and registered once, because `onSave` is rebuilt every
   * render: registering that directly would re-run the effect on every
   * keystroke, and the host would be holding a stale closure the moment it
   * did not.
   *
   * A clean panel is a no-op -- saving restarts the backend and would kill a
   * draft in progress, so an unchanged panel must not trigger one. An
   * invalid panel, or one whose save was refused, resolves `false` and the
   * host keeps the dialog open rather than discarding what the user typed:
   * the reason is on screen behind it.
   */
  const commitRef = useRef<() => Promise<boolean>>(async () => true);
  commitRef.current = async () => {
    if (!dirty) {
      return true;
    }
    if (blocked) {
      return false;
    }
    return onSave();
  };

  useEffect(() => {
    const commit = () => commitRef.current();
    onRegisterCommit?.(commit);
    return () => onRegisterCommit?.(null);
  }, [onRegisterCommit]);

  const onBrowseModel = async (key: "llama_model_path" | "llama_fallback_model_path") => {
    const chosen = await pickFile({
      title: key === "llama_model_path" ? "Choose a model file" : "Choose a fallback model file",
      extensions: ["gguf"],
      filterName: "Model files",
      startingAt: draft[key] || draft.llama_model_path
    });
    if (chosen) {
      update(key, chosen);
    }
  };

  const onOpenLogs = async () => {
    try {
      const result = await window.localAgent?.openLogsFolder?.();
      if (result && !result.ok) {
        toast.show({
          tone: "error",
          title: "The logs folder could not be opened",
          body: result.error ?? "Open it from Explorer instead."
        });
      }
    } catch {
      toast.show({
        tone: "error",
        title: "The logs folder could not be opened",
        body: "Open it from Explorer instead."
      });
    }
  };

  // `null` when the cron came from Advanced and says something the three
  // controls cannot express -- a step, a list, a month restriction. The
  // picker is then replaced by the expression itself rather than quietly
  // rewriting it into something simpler on the next save.
  const schedule = cronToSchedule(draft.rag_sync_schedule);

  const setSchedule = (next: Partial<typeof DEFAULT_SCHEDULE>): void => {
    const base = schedule ?? DEFAULT_SCHEDULE;
    update("rag_sync_schedule", scheduleToCron({ ...base, ...next }));
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="flex items-center gap-2 text-sm text-ink-faint">
          <Spinner size="sm" />
          Reading settings
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">Settings</h1>
          <p className="mt-1 text-xs text-ink-muted">
            Saving restarts the backend, which stops any draft in progress.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* A live region: it changes without focus moving, and it is the
              only signal that there is anything pending.

              Not "Unsaved changes" in amber any more. Closing now saves, so
              nothing here can be lost and a warning colour for a state with
              no loss in it is just noise -- this says what will happen. */}
          <p className="text-xs" aria-live="polite">
            {dirty ? (
              <span className="text-ink-muted">Saves when you close</span>
            ) : justSaved ? (
              <span className="flex items-center gap-1 text-viridian">
                <Check className="h-3 w-3" />
                Saved
              </span>
            ) : null}
          </p>
          <Button
            variant="primary"
            onClick={() => void onSave()}
            disabled={!hostAvailable || !dirty || blocked || saving}
          >
            {saving ? (
              <>
                <Spinner size="sm" />
                Saving
              </>
            ) : (
              "Save settings"
            )}
          </Button>
          {headerEnd}
        </div>
      </header>

      {/* Sidebar + one category at a time, like the reference (user's call,
          15 Oct 2026). The alerts sit ABOVE the split, not inside the pane:
          "the host is unreachable" and "the save failed" are about the whole
          panel, and putting them in the right pane would hide them whenever
          the user happened to be on another category. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {(!hostAvailable || saveError) && (
          <div className="px-6 pt-6">
            {!hostAvailable && (
              <Panel className="mb-4 border-amber bg-amber-wash p-4">
                <p className="flex items-start gap-2 text-sm text-ink">
                  <Alert className="mt-px h-4 w-4 shrink-0 text-amber" />
                  Settings can only be changed in the desktop app. These values are the defaults,
                  not what is stored.
                </p>
              </Panel>
            )}

            {saveError && (
              <Panel className="mb-4 border-vermilion bg-vermilion-wash p-4">
                <p className="flex items-start gap-2 text-sm text-ink" role="alert">
                  <Alert className="mt-px h-4 w-4 shrink-0 text-vermilion" />
                  {saveError}
                </p>
              </Panel>
            )}
          </div>
        )}

        <div className="flex min-h-0 items-stretch">
          <CategoryNav
            current={category}
            onSelect={setCategory}
            advancedHasError={advancedHasError}
          />

          {/* `min-w-0` or a long unbroken path in a text input pushes the
              pane wider than the dialog and the sidebar scrolls away. */}
          <div className="min-w-0 flex-1 px-6 py-6">
            <CategoryPane id="drafting" current={category}>
              <SettingsSection
                title="Drafting"
                description="Which model writes the reply, and how it behaves by default."
              >
                <Row>
                  <ModelStatus
                    health={health}
                    offline={backendOffline}
                    onRecheck={onRecheck}
                  />
                </Row>

                <Row>
                  <Field
                    label="Model file"
                    htmlFor="llama-model-path"
                    error={modelPathWarning(draft.llama_model_path)}
                    hint="A .gguf file on this machine."
                  >
                    <PathInput
                      id="llama-model-path"
                      value={draft.llama_model_path}
                      onChange={(value) => update("llama_model_path", value)}
                      onBrowse={() => void onBrowseModel("llama_model_path")}
                      disabled={!hostAvailable}
                      placeholder="No model chosen"
                    />
                  </Field>
                </Row>

                <Row>
                  <Field
                    label="Fallback model file"
                    htmlFor="llama-fallback-path"
                    optional
                    error={modelPathWarning(draft.llama_fallback_model_path)}
                    hint="Tried only if the model above fails to load."
                  >
                    <PathInput
                      id="llama-fallback-path"
                      value={draft.llama_fallback_model_path}
                      onChange={(value) => update("llama_fallback_model_path", value)}
                      onBrowse={() => void onBrowseModel("llama_fallback_model_path")}
                      disabled={!hostAvailable}
                      placeholder="None"
                    />
                  </Field>
                </Row>

                <Row>
                  <Field
                    layout="row"
                    label="Default temperature"
                    htmlFor="default-temperature"
                    hint="Lower stays closer to the statute. Each draft can still override this."
                  >
                    {/* A fixed width rather than `flex-1`: in a row layout the
                        control sizes itself, and a slider that resized with
                        the label beside it would jump between categories. */}
                    <div className="flex w-[13rem] items-center gap-3">
                      {/* Radix slider is multi-thumb by design, so a single
                          setting is a one-element array in and out. */}
                      <Slider
                        id="default-temperature"
                        min={0}
                        max={1}
                        step={0.05}
                        value={[draft.default_temperature]}
                        onValueChange={(next: number[]) => {
                          const first = next[0];
                          if (first !== undefined) {
                            update("default_temperature", first);
                          }
                        }}
                        disabled={!hostAvailable}
                        aria-label="Default temperature"
                      />
                      <span className="w-8 shrink-0 text-right font-mono text-xs text-ink-muted">
                        {draft.default_temperature.toFixed(2)}
                      </span>
                    </div>
                  </Field>
                </Row>

                <Row>
                  {/* `Field` owns the label, not `Switch`: the Switch's own
                      label prop puts the control on the LEFT, and the point of
                      the row layout is one column of controls down the right
                      edge. */}
                  <Field
                    layout="row"
                    label="Save every reply as a Word file"
                    htmlFor="always-save-docx"
                    hint="You can still change this per reply."
                  >
                    <Switch
                      id="always-save-docx"
                      checked={draft.always_save_docx}
                      onCheckedChange={(checked) => update("always_save_docx", checked)}
                      disabled={!hostAvailable}
                    />
                  </Field>
                </Row>
              </SettingsSection>
            </CategoryPane>

            <CategoryPane id="corpus" current={category}>
              <SettingsSection
                title="Case law and circulars"
                description="A local index of judgments and circulars the replies cite from."
              >
                <Row>
                  <Field
                    label="Update the index"
                    htmlFor="schedule-frequency"
                    hint="Updates fetch new judgments over the internet and can take a few minutes."
                  >
                    {schedule ? (
                      // `items-end`, not `items-center`: the controls have
                      // different label heights and the inputs must share a
                      // baseline, not their boxes' midpoints.
                      <div className="flex flex-wrap items-end gap-3">
                        {/* Two choices, so both are visible and each is one
                            click. A select here cost two clicks to move
                            between exactly two options. */}
                        <SegmentedControl
                          id="schedule-frequency"
                          aria-label="How often to update the index"
                          value={schedule.frequency}
                          onChange={(value) => setSchedule({ frequency: value })}
                          options={FREQUENCIES}
                          disabled={!hostAvailable}
                        />

                        {schedule.frequency === "weekly" ? (
                          <div className="w-[9.5rem] shrink-0">
                            <SelectRoot
                              value={String(schedule.weekday)}
                              onValueChange={(value) =>
                                setSchedule({ weekday: Number(value) })
                              }
                              disabled={!hostAvailable}
                            >
                              <SelectTrigger id="schedule-weekday" aria-label="Which day">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {WEEKDAYS.map((d) => (
                                  <SelectItem key={d.value} value={d.value}>
                                    {d.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </SelectRoot>
                          </div>
                        ) : null}

                        {/* Neither `<input type="time">` (WebView2 draws its
                            own picker in OS chrome the theme cannot reach) nor
                            a 48-row list (reaching 2:30 am meant scrolling past
                            twenty other rows). A clock face is spatial, so the
                            hour is a place rather than a search. The trigger is
                            styled as a select so it sits level with the two
                            beside it. */}
                        <div className="w-[9.5rem] shrink-0">
                          <PopoverRoot>
                            <PopoverTrigger
                              id="schedule-time"
                              aria-label="At what time"
                              disabled={!hostAvailable}
                              className={cn(
                                "flex h-8 w-full items-center justify-between gap-2 rounded-control border border-rule-strong bg-surface px-2",
                                "text-sm text-ink transition-colors duration-120 ease-ledger",
                                "hover:bg-sunken",
                                "disabled:cursor-not-allowed disabled:bg-sunken disabled:text-ink-faint",
                                focusRingOnSurface
                              )}
                            >
                              {formatTimeOfDay(schedule.time)}
                              <Clock className="h-4 w-4 shrink-0 text-ink-faint" />
                            </PopoverTrigger>
                            <PopoverContent className="w-auto">
                              <TimeDial
                                value={schedule.time}
                                onChange={(time) => setSchedule({ time })}
                                disabled={!hostAvailable}
                                aria-label="Time of day to update the index"
                              />
                            </PopoverContent>
                          </PopoverRoot>
                        </div>
                      </div>
                    ) : (
                      // The cron says something these controls cannot: show it
                      // rather than a picker that would discard it on save.
                      <p className="text-sm text-ink-muted">
                        {cronError
                          ? "The schedule in Advanced is not valid."
                          : describeCron(draft.rag_sync_schedule)}{" "}
                        <span className="text-ink-faint">Set in Advanced.</span>
                      </p>
                    )}
                  </Field>
                </Row>

                <Row>
                  <Field
                    label="Indian Kanoon API key"
                    htmlFor="ik-token"
                    optional
                    hint={
                      tokenEdited
                        ? "This will replace the stored key when you save."
                        : "Without a key, judgments are not fetched automatically. Documents you add yourself are still indexed."
                    }
                  >
                    <TextInput
                      id="ik-token"
                      mono
                      // Not type="password": the value here is already a mask,
                      // and dots over dots tells the user nothing about whether
                      // a key is set at all.
                      value={draft.indiankanoon_token}
                      onChange={(e) => update("indiankanoon_token", e.target.value)}
                      disabled={!hostAvailable}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="Not set"
                    />
                  </Field>
                </Row>
              </SettingsSection>
            </CategoryPane>

            <CategoryPane id="windows" current={category}>
              <SettingsSection
                title="Windows"
                description="How the app behaves on this machine."
              >
                <Row>
                  <Field
                    layout="row"
                    label="Appearance"
                    hint={
                      theme === "system"
                        ? `Following this machine, currently ${systemDark ? "dark" : "light"}.`
                        : "Applies straight away. Save is for the settings below."
                    }
                  >
                    <SegmentedControl
                      aria-label="Appearance"
                      value={theme}
                      onChange={onThemeChange}
                      options={THEMES}
                    />
                  </Field>
                </Row>

                <Row>
                  <Field
                    layout="row"
                    label="Open when I sign in"
                    htmlFor="run-at-startup"
                    hint="The window opens with Windows, ready for the first notice of the day."
                  >
                    <Switch
                      id="run-at-startup"
                      checked={draft.run_at_startup}
                      onCheckedChange={(checked) => update("run_at_startup", checked)}
                      disabled={!hostAvailable}
                    />
                  </Field>
                </Row>
              </SettingsSection>
            </CategoryPane>

            <CategoryPane id="advanced" current={category}>
              <SettingsSection
                title="Advanced"
                description="Everything here already has a working default. A wrong value breaks drafting in a way the error messages cannot fully explain."
              >
                <Row>
                  <Field
                    label="Layers on the GPU"
                    htmlFor="llama-gpu-layers"
                    error={gpuLayersError}
                    hint="Lower this if drafting fails with an out-of-memory error. 999 uses the whole GPU. The model itself is under Drafting."
                  >
                    <TextInput
                      id="llama-gpu-layers"
                      mono
                      inputMode="numeric"
                      value={draft.llama_gpu_layers_text}
                      onChange={(e) => update("llama_gpu_layers_text", e.target.value)}
                      disabled={!hostAvailable}
                    />
                  </Field>
                </Row>

                <Row>
                  <Field
                    label="Context size"
                    htmlFor="llama-ctx-size"
                    error={ctxSizeError}
                    hint="How much of the notice and conversation the model reads at once. Larger uses more memory."
                  >
                    <TextInput
                      id="llama-ctx-size"
                      mono
                      inputMode="numeric"
                      value={draft.llama_ctx_size_text}
                      onChange={(e) => update("llama_ctx_size_text", e.target.value)}
                      disabled={!hostAvailable}
                    />
                  </Field>
                </Row>

                <Row>
                  <Field
                    label="Schedule expression"
                    htmlFor="schedule-cron"
                    error={cronError}
                    // The gloss is the feedback: a CA should not have to parse
                    // five cron fields to know when the index updates.
                    hint={cronError ? undefined : describeCron(draft.rag_sync_schedule)}
                  >
                    <TextInput
                      id="schedule-cron"
                      mono
                      value={draft.rag_sync_schedule}
                      onChange={(e) => update("rag_sync_schedule", e.target.value)}
                      disabled={!hostAvailable}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </Field>
                </Row>

                <Row>
                  <Field
                    layout="row"
                    label="Logs"
                    htmlFor="open-logs"
                    hint="Start here when a sync or a draft fails without saying why."
                  >
                    <Button
                      id="open-logs"
                      variant="secondary"
                      onClick={() => void onOpenLogs()}
                      // `hostAvailable` is state, so this re-renders once the
                      // bridge is installed. Reading window.localAgent here
                      // instead would latch the value from first paint, which
                      // happens before installBridge() runs, leaving the
                      // button permanently disabled in the packaged app.
                      disabled={!hostAvailable}
                    >
                      <Folder className="h-4 w-4" />
                      Open logs folder
                    </Button>
                  </Field>
                </Row>
              </SettingsSection>
            </CategoryPane>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The category list down the left of the panel.
 *
 * Deliberately NOT a Radix `Tabs`, even though it looks like one. Tabs own
 * roving focus and a single tab stop, which is right when the tab strip sits
 * above its panel and arrow keys are the obvious way across. Here the list is
 * a vertical column beside a form the user tabs into constantly, and a tab
 * strip would mean Tab leaves the whole list after one press -- so reaching
 * Advanced from Drafting by keyboard would need arrow keys nobody discovers
 * on a sidebar. Four plain buttons, four tab stops, `aria-current="page"`.
 *
 * Not links either: nothing here is addressable and there is no history to
 * go back through.
 */
function CategoryNav({
  current,
  onSelect,
  advancedHasError
}: {
  current: CategoryId;
  onSelect: (id: CategoryId) => void;
  advancedHasError: boolean;
}) {
  return (
    <nav
      aria-label="Settings categories"
      // The rule, not a fill: a tinted sidebar would be a second surface
      // colour the contract does not have, and the panel already sits on
      // `--surface` inside the dialog.
      className="w-[13rem] shrink-0 border-r border-rule py-6 pl-6 pr-3"
    >
      <ul className="flex flex-col gap-px">
        {CATEGORIES.map((item) => {
          const Icon = item.icon;
          const active = item.id === current;
          const flagged = item.id === "advanced" && advancedHasError;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-control px-2 py-2 text-left text-sm",
                  "transition-colors duration-120 ease-ledger",
                  focusRingOnSurface,
                  active
                    ? "bg-seal-wash font-medium text-seal"
                    : "text-ink-muted hover:bg-sunken hover:text-ink"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {/* A dot, not a count or a word: it says "there is something
                    wrong on this page" and the page itself says what. Paired
                    with the Save button being disabled, which is the other
                    half of the same signal. */}
                {flagged ? (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-vermilion"
                    role="img"
                    aria-label="Needs attention"
                  />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * One category's pane. Rendered only when it is the current one.
 *
 * Unmounted rather than hidden, for the same reason the Advanced disclosure
 * it replaced was: a hidden pane that still holds focusable fields is a
 * keyboard trap, and `display:none` is the only form of hiding that is not.
 * Unmounting is also what keeps the panel's scroll position sane -- a tall
 * hidden Drafting pane would leave the short Windows pane scrolled.
 *
 * Draft state lives in `SettingsView`, not in the panes, so unmounting loses
 * nothing: edits on a category survive navigating away, come back when the
 * user returns, and are still there to be written when the panel closes.
 */
function CategoryPane({
  id,
  current,
  children
}: {
  id: CategoryId;
  current: CategoryId;
  children: React.ReactNode;
}) {
  if (id !== current) return null;
  return <div className="max-w-measure">{children}</div>;
}

/**
 * Whether the model is actually loaded, shown where the model is chosen.
 *
 * Settings used to be the one screen that never said this: a user could set a
 * path, save, and get no confirmation that anything had loaded until the next
 * draft failed. The data was already on `/health`.
 */
function ModelStatus({
  health,
  offline,
  onRecheck
}: {
  health: HealthResponse | null;
  offline: boolean;
  onRecheck: () => void | Promise<unknown>;
}) {
  const { dot, text, label } = describeModelStatus(health, offline);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="flex items-center gap-2 text-sm">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", dot)} aria-hidden="true" />
        <span className={text}>{label}</span>
      </span>
      <button
        type="button"
        onClick={() => void onRecheck()}
        className="rounded-control text-xs text-ink-muted underline underline-offset-2 transition-colors duration-120 ease-ledger hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-seal focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        Check again
      </button>
    </div>
  );
}

function describeModelStatus(
  health: HealthResponse | null,
  offline: boolean
): { dot: string; text: string; label: string } {
  if (offline || !health) {
    return {
      dot: "bg-vermilion",
      text: "text-vermilion",
      label: "The backend is not running."
    };
  }
  // `ollama_running` keeps its v1 name on the wire for compatibility; it
  // means "the model server answered". For v2 that server is llama-server.
  if (!health.ollama_running) {
    return {
      dot: "bg-amber",
      text: "text-amber",
      label: "The model server is not running."
    };
  }
  if (health.loaded_model) {
    return {
      dot: "bg-viridian",
      text: "text-ink-muted",
      label: `Ready — ${health.loaded_model} is loaded.`
    };
  }
  return {
    dot: "bg-amber",
    text: "text-amber",
    label: "No model is loaded. Choose a .gguf file below."
  };
}

/** A path field with a Browse button, so nobody types an absolute path. */
function PathInput({
  id,
  value,
  onChange,
  onBrowse,
  disabled,
  placeholder
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBrowse: () => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <TextInput
        id={id}
        mono
        className="min-w-0 flex-1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      <Button variant="secondary" onClick={onBrowse} disabled={disabled} className="shrink-0">
        <Folder className="h-4 w-4" />
        Browse
      </Button>
    </div>
  );
}

function SettingsSection({
  title,
  description,
  children,
  className
}: {
  title: string;
  /** Omit it when the heading and the rows under it already say everything:
   *  a description that restates its own heading is noise, and rendering an
   *  empty `<p>` would still take the margin. */
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <h2 className="text-sm font-medium text-ink">{title}</h2>
      {description ? (
        <p className="mt-1 text-xs text-ink-muted">{description}</p>
      ) : null}
      {/* Rules between rows rather than a card per setting — the contract's
          separation rule, and it keeps a long form scannable. */}
      <div className="mt-4 divide-y divide-rule border-y border-rule">
        {children}
      </div>
    </section>
  );
}

/** One setting per row, with the vertical rhythm that the dividers separate. */
function Row({ children }: { children: React.ReactNode }) {
  return <div className="py-4">{children}</div>;
}
