/**
 * Backend + host bridge types. Mirrors `docs/API.md`.
 *
 * These names match the live backend exactly. Do not rename a field to read
 * better in the UI — map it at the component boundary instead.
 */

/** Mirrors `HealthResponse` in `backend-rs/src/routes/health.rs`. */
export type HealthResponse = {
  status: "ok" | "degraded";
  /**
   * Whether the inference server answers. Kept under v1's name on purpose:
   * an installed v1 frontend reads this key, and renaming a wire field breaks
   * clients that update the two halves independently. v2 runs llama.cpp, so
   * read this as "the model server is up", not "Ollama is up".
   */
  ollama_running: boolean;
  primary_model: string;
  primary_available: boolean;
  fallback_model: string;
  fallback_available: boolean;
  error: string | null;

  // v2 additions.
  engine: string;
  base_url: string;
  /** The model the running server has loaded, if any. */
  loaded_model: string | null;
  /** True when this backend started the inference server itself. */
  server_managed: boolean;
};

export type ModelInfo = {
  name: string;
  size: number;
  modified_at: string;
  /**
   * Absolute path to the GGUF. This, not `name`, is what `POST /generate`
   * accepts as a `model` override -- sending the bare stem lets the backend
   * fall through to its own primary and silently draft with another model.
   */
  path: string;
};

/** `GET /models` wraps the list — it is not a bare array. */
export type ModelsResponse = {
  primary: string;
  fallback: string;
  models: ModelInfo[];
  /** Loaded by the running server. With no configured path, the only usable one. */
  loaded: string | null;
};

export type UploadResponse = {
  /** The name actually written — differs from the uploaded name on collision. */
  filename: string;
  saved_path: string;
  char_count: number;
  text: string;
};

export type UploadErrorCode =
  | "unsupported_type"
  | "too_large"
  | "empty_text"
  | "network"
  | "timeout"
  | "backend"
  | "unknown";

export type UploadError = {
  code: UploadErrorCode;
  message: string;
  detail?: string;
};

export type HistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

export type GenerateRequest = {
  text: string;
  query: string;
  /** null lets the backend auto-select (qwen2.5:14b → deepseek-r1:14b). */
  model: string | null;
  history: HistoryTurn[];
  /** null starts a new session. */
  session_id: string | null;
  temperature: number;
  /** Defaults to false server-side — no .docx is written unless true. */
  save_output: boolean;
};

export type GenerateResponse = {
  reply: string;
  model_used: string;
  /** null when save_output was false. */
  output_file: string | null;
  session_id: string;
};

/**
 * Mirrors `RagStatusResponse` in `backend-rs/src/routes/rag.rs`. Every field is
 * required because the backend serialises a struct, not a map -- an optional
 * field here would let a typo compile and read `undefined` forever.
 */
export type RagStatus = {
  last_sync: string | null;
  docs_total: number;
  docs_added_last_run: number;
  last_sync_status: string;
  /** Why the last sync was partial or failed. Empty on success. */
  errors: string[];
  next_scheduled_sync: string | null;
  embedding_model_available: boolean;
  chunks_total: number;
  superseded_docs: number;
  /** v2 addition: lets the UI disable the sync button while one runs. */
  sync_in_progress: boolean;
};

export type RagDocument = {
  title?: string;
  source?: string;
  doc_type?: string;
  date?: string;
  chunks?: number;
  superseded?: boolean;
  superseded_by?: string | null;
  url?: string;
  [key: string]: unknown;
};

export type RagDocsFolder = {
  path: string;
  exists: boolean;
};

// ---------------------------------------------------------------------------
// Host bridge
// ---------------------------------------------------------------------------

export type SessionSummary = {
  session_id: string;
  created_at: string;
  updated_at: string;
  turn_count: number;
};

export type SessionTurn = {
  timestamp: string;
  model: string;
  notice_text: string;
  query: string;
  reply: string;
  /** "" when nothing was saved. */
  output_file: string;
};

export type StoredSession = {
  session_id: string;
  created_at: string;
  updated_at: string;
  turns: SessionTurn[];
};

/**
 * Mirrors `src-tauri/src/config.rs::AppConfig`, which is the authority: the
 * host writes `config-rs.json`, and a key this type does not know is a key
 * the Settings form cannot edit. v2 runs llama-server, so the `ollama_*` and
 * `model_storage_path` keys v1 had are gone -- they are not renames of these.
 */
export type AppConfig = {
  llama_host: string;
  llama_port: number;
  /** Empty means "discover it"; the backend finds and spawns llama-server. */
  llama_server_path: string;
  /** Absolute path to a `.gguf`. Empty means no model is configured. */
  llama_model_path: string;
  llama_fallback_model_path: string;
  llama_ctx_size: number;
  /** Layers to offload to the GPU; 999 means "all that fit". */
  llama_gpu_layers: number;
  backend_port: number;
  /**
   * ALWAYS MASKED across the bridge. Send it back untouched when the user did
   * not edit it — the host treats an unchanged mask as "keep the real token".
   * Never log this, never put it in an error message.
   */
  indiankanoon_token: string;
  incometax_pdf_scraper_enabled: boolean;
  rag_sync_schedule: string;
  run_at_startup: boolean;
  /**
   * Persisted but NOT implemented: no tray icon is ever constructed and no
   * close handler keeps the app alive, so closing the window exits -- the
   * opposite of what a tray switch promises. The Settings panel does not
   * offer it. Kept on the type because the host still round-trips the key.
   */
  system_tray: boolean;
  /**
   * Persisted but NOT implemented: nothing calls `SetThreadExecutionState`,
   * so Windows sleeps mid-draft regardless. See `system_tray`.
   */
  keep_awake: boolean;

  /**
   * Seeds the temperature slider on a fresh draft. Host-only: the backend
   * takes temperature per request and has no such key.
   */
  default_temperature: number;
  /** Seeds the "save a .docx" switch on a fresh draft. Host-only. */
  always_save_docx: boolean;
};

export type DesktopSettings = {
  run_at_startup: boolean;
  system_tray: boolean;
  keep_awake: boolean;
};

export type OkResult = { ok: boolean; error?: string };
export type SuccessResult = { success: boolean; error?: string };
export type SaveConfigResult = {
  success: boolean;
  error?: string;
  backend_port?: number;
  config?: AppConfig;
};

/**
 * The host bridge. Field names are frozen — v1 Electron and v2 Tauri expose
 * the identical shape so the renderer is portable between them.
 */
export type LocalAgent = {
  openOutputFolder(outputFile: string): Promise<OkResult>;
  listSessions(): Promise<SessionSummary[]>;
  readSession(sessionId: string): Promise<StoredSession>;
  deleteSession(sessionId: string): Promise<SuccessResult>;
  getConfig(): Promise<AppConfig>;
  saveConfig(next: Partial<AppConfig>): Promise<SaveConfigResult>;
  openLogsFolder(): Promise<OkResult>;
  getBackendPort(): Promise<number>;
  getBackendAuth(): Promise<string>;
  applyDesktopSettings(settings: DesktopSettings): Promise<SuccessResult>;
  // v2 additions — absent on the v1 Electron bridge, so always optional-chain.
  backendStatus?(): Promise<{ online: boolean; port: number }>;
  retryBackend?(): Promise<SuccessResult>;
  openPathInBase?(path: string): Promise<OkResult>;
  showMainWindow?(): Promise<void>;
};

declare global {
  interface Window {
    localAgent?: LocalAgent;
  }
}
