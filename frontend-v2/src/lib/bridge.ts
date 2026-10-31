/**
 * Installs `window.localAgent` over Tauri `invoke()`.
 *
 * v1 was Electron and exposed this object from a preload script. v2 is Tauri,
 * so the host is Rust — but the renderer-facing shape is identical on purpose
 * (see `docs/API.md`). Components call `window.localAgent?.listSessions?.()`
 * and never know which host they are on.
 *
 * In a plain browser (`npm run dev:web`) there is no Tauri runtime, so the
 * bridge is simply not installed and every call site's optional chaining takes
 * over. The UI must stay usable in that mode.
 */

import type {
  AppConfig,
  DesktopSettings,
  LocalAgent,
  OkResult,
  SaveConfigResult,
  SessionSummary,
  StoredSession,
  SuccessResult
} from "@/types/api";

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeFn: InvokeFn | null = null;

/** True when running inside the Tauri webview rather than a plain browser. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Load the Tauri API and install the bridge. Resolves to true when the bridge
 * is live. Safe to call in a browser — it resolves false instead of throwing.
 */
export async function installBridge(): Promise<boolean> {
  if (!isTauri()) {
    return false;
  }
  if (window.localAgent) {
    return true;
  }
  try {
    const core = await import("@tauri-apps/api/core");
    invokeFn = core.invoke as InvokeFn;
    window.localAgent = buildAgent(invokeFn);
    return true;
  } catch {
    // A failed import must not prevent the UI mounting; the app degrades to
    // "host unavailable" rather than a blank window.
    return false;
  }
}

function buildAgent(invoke: InvokeFn): LocalAgent {
  return {
    openOutputFolder: (outputFile: string) =>
      invoke<OkResult>("open_output_folder", { outputFile }),

    listSessions: () => invoke<SessionSummary[]>("list_sessions"),

    readSession: (sessionId: string) =>
      invoke<StoredSession>("read_session", { sessionId }),

    deleteSession: (sessionId: string) =>
      invoke<SuccessResult>("delete_session", { sessionId }),

    getConfig: () => invoke<AppConfig>("get_config"),

    // `next` is the partial patch; the host merges it over the stored config
    // and restores the real Indian Kanoon token when the mask came back
    // unchanged.
    saveConfig: (next: Partial<AppConfig>) =>
      invoke<SaveConfigResult>("save_config", { next }),

    openLogsFolder: () => invoke<OkResult>("open_logs_folder"),

    getBackendPort: () => invoke<number>("get_backend_port"),

    getBackendAuth: () => invoke<string>("get_backend_auth"),

    applyDesktopSettings: (settings: DesktopSettings) =>
      invoke<SuccessResult>("apply_desktop_settings", { settings }),

    backendStatus: () =>
      invoke<{ online: boolean; port: number }>("backend_status"),

    retryBackend: () => invoke<SuccessResult>("retry_backend"),

    openPathInBase: (path: string) => invoke<OkResult>("open_path_in_base", { path }),

    showMainWindow: () => invoke<void>("show_main_window")
  };
}

/**
 * Subscribe to the host's backend lifecycle events.
 *
 * The host brings `backend.exe` up on a worker thread (a cold start is ~23 s
 * and the budget is 120 s), so the renderer paints immediately and learns the
 * outcome here. Returns an unsubscribe function.
 */
export async function onBackendLifecycle(handlers: {
  onReady?: (port: number) => void;
  onFailed?: (message: string) => void;
}): Promise<() => void> {
  if (!isTauri()) {
    return () => {};
  }
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const offReady = await listen<number>("backend-ready", (e) => {
      handlers.onReady?.(e.payload);
    });
    const offFailed = await listen<string>("backend-failed", (e) => {
      handlers.onFailed?.(e.payload);
    });
    return () => {
      offReady();
      offFailed();
    };
  } catch {
    return () => {};
  }
}

/** Tell the host the renderer has painted, so the window can be shown. */
export async function signalRendererReady(): Promise<void> {
  try {
    await window.localAgent?.showMainWindow?.();
  } catch {
    /* the host has a 5 s fallback that shows the window anyway */
  }
}
