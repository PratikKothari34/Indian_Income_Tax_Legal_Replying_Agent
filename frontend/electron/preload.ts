import { contextBridge, ipcRenderer } from "electron";

// IMPORTANT: this object is exposed as `window.localAgent` — do not rename.
// All four original channels are preserved verbatim; the *-config / logs /
// port helpers below are additive and used by the Settings screen.
contextBridge.exposeInMainWorld("localAgent", {
  openOutputFolder: (outputFile: string) => ipcRenderer.invoke("open-output-folder", outputFile),
  listSessions: () => ipcRenderer.invoke("list-sessions"),
  readSession: (sessionId: string) => ipcRenderer.invoke("read-session", sessionId),
  deleteSession: (sessionId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("delete-session", sessionId),
  getConfig: (): Promise<{
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
  }> => ipcRenderer.invoke("get-config"),
  saveConfig: (
    next: Partial<{
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
    }>
  ): Promise<{
    success: boolean;
    error?: string;
    backend_port?: number;
    config?: unknown;
  }> => ipcRenderer.invoke("save-config", next),
  openLogsFolder: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("open-logs-folder"),
  getBackendPort: (): Promise<number> => ipcRenderer.invoke("get-backend-port"),
  applyDesktopSettings: (settings: {
    run_at_startup: boolean;
    system_tray: boolean;
    keep_awake: boolean;
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("apply-desktop-settings", settings)
});
