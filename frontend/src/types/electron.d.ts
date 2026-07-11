import type { SessionSummary, StoredSession } from "./api";

type AppConfig = {
  ollama_host: string;
  ollama_port: number;
  backend_port: number;
  model_storage_path: string;
  indiankanoon_token: string;
  incometax_pdf_scraper_enabled: boolean;
  rag_sync_schedule: string;
  run_at_startup: boolean;
  system_tray: boolean;
  keep_awake: boolean;
};

declare global {
  interface Window {
    localAgent: {
      openOutputFolder: (outputFile: string) => Promise<{ ok: boolean; error?: string }>;
      listSessions: () => Promise<SessionSummary[]>;
      readSession: (sessionId: string) => Promise<StoredSession>;
      deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
      getConfig: () => Promise<AppConfig>;
      saveConfig: (next: Partial<AppConfig>) => Promise<{
        success: boolean;
        error?: string;
        backend_port?: number;
        config?: unknown;
      }>;
      openLogsFolder: () => Promise<{ ok: boolean; error?: string }>;
      getBackendPort: () => Promise<number>;
      getBackendAuth: () => Promise<string>;
      applyDesktopSettings: (settings: {
        run_at_startup: boolean;
        system_tray: boolean;
        keep_awake: boolean;
      }) => Promise<{ success: boolean; error?: string }>;
    };
  }
}

export {};
