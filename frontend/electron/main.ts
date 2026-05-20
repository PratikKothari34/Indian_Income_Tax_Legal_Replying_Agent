import { app, BrowserWindow, Menu, Tray, ipcMain, shell, dialog, nativeImage, powerSaveBlocker } from "electron";
import fs from "node:fs/promises";
import { existsSync, unlinkSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Telemetry / crash reporter — disabled. Strictly local app.
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch("disable-crash-reporter");
app.commandLine.appendSwitch("disable-features", "Crashpad,HardwareMediaKeyHandling");
process.env["ELECTRON_DISABLE_SANDBOX_DEVTOOLS_EXTENSIONS"] = "1";

const DEV_URL = "http://127.0.0.1:5173";

// ---------------------------------------------------------------------------
// AppData layout — must match backend/paths.py exactly.
// ---------------------------------------------------------------------------
function localAppData(): string {
  return process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");
}
const APPDATA_BASE_DIR = path.join(localAppData(), "ITaxReplyAgent");
const APPDATA_DATA_DIR = path.join(APPDATA_BASE_DIR, "data");
const APPDATA_OUTPUT_DIR = path.join(APPDATA_BASE_DIR, "output");
const APPDATA_UPLOADS_DIR = path.join(APPDATA_BASE_DIR, "uploads");
const APPDATA_LOGS_DIR = path.join(APPDATA_BASE_DIR, "logs");
const APPDATA_RAG_DIR = path.join(APPDATA_BASE_DIR, "rag");
const APPDATA_RAG_DOCS_DIR = path.join(APPDATA_RAG_DIR, "docs");
const APPDATA_RAG_CHROMADB_DIR = path.join(APPDATA_RAG_DIR, "chromadb");
const APPDATA_RAG_MODELS_DIR = path.join(APPDATA_RAG_DIR, "models");
const APPDATA_CONFIG_PATH = path.join(APPDATA_BASE_DIR, "config.json");
const APPDATA_PORT_FILE = path.join(APPDATA_BASE_DIR, "port.txt");
const APPDATA_FRONTEND_LOG = path.join(APPDATA_LOGS_DIR, "frontend.log");

/**
 * Eagerly create every runtime directory the backend expects. We do this
 * once at startup (production only) so the first backend boot finds an
 * empty-but-present tree. The backend's paths.py also calls ensure_dirs()
 * for safety; this is belt-and-braces against a corrupt AppData.
 */
async function ensureAppDataDirs(): Promise<void> {
  for (const d of [
    APPDATA_BASE_DIR,
    APPDATA_DATA_DIR,
    APPDATA_OUTPUT_DIR,
    APPDATA_UPLOADS_DIR,
    APPDATA_LOGS_DIR,
    APPDATA_RAG_DIR,
    APPDATA_RAG_DOCS_DIR,
    APPDATA_RAG_CHROMADB_DIR,
    APPDATA_RAG_MODELS_DIR
  ]) {
    try {
      await fs.mkdir(d, { recursive: true });
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Path helpers — switch dev/prod via app.isPackaged, NEVER via NODE_ENV.
// ---------------------------------------------------------------------------
function dataDir(): string {
  return app.isPackaged ? APPDATA_DATA_DIR : path.join(__dirname, "../../backend/data");
}
function outputDir(): string {
  return app.isPackaged ? APPDATA_OUTPUT_DIR : path.join(__dirname, "../../backend/output");
}
function backendExePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "backend.exe")
    : path.join(__dirname, "../../dist-backend/backend.exe");
}
function appIconPath(): string {
  return app.isPackaged
    ? path.join(app.getAppPath(), "assets", "icon.png")
    : path.join(__dirname, "../assets/icon.png");
}

// ---------------------------------------------------------------------------
// Lightweight frontend logger — writes to AppData\...\logs\frontend.log so
// failures during backend spawn are debuggable on the deploy machine.
// ---------------------------------------------------------------------------
async function ensureLogsDir(): Promise<void> {
  try {
    await fs.mkdir(APPDATA_LOGS_DIR, { recursive: true });
  } catch {
    /* best-effort */
  }
}
async function frontendLog(line: string): Promise<void> {
  try {
    await ensureLogsDir();
    const stamp = new Date().toISOString();
    await fs.appendFile(APPDATA_FRONTEND_LOG, `${stamp} ${line}\n`, "utf-8");
  } catch {
    /* never crash on log failure */
  }
}

// ---------------------------------------------------------------------------
// Config — read on every startup. Recreate on missing/corrupt.
// ---------------------------------------------------------------------------
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
type DesktopSettings = Pick<AppConfig, "run_at_startup" | "system_tray" | "keep_awake">;
const DEFAULT_CONFIG: AppConfig = {
  ollama_host: "127.0.0.1",
  ollama_port: 11434,
  backend_port: 8000,
  model_storage_path: path.join(os.homedir(), ".ollama", "models"),
  // Empty token disables the Indian Kanoon auto-scrape (manual ingest
  // still works). Real token is written by the installer or via the
  // Settings panel — never hardcoded.
  indiankanoon_token: "",
  // The incometax /news/*.pdf probe is opt-in because Akamai may 403
  // it depending on the deploy IP. Toggle from the Settings panel.
  incometax_pdf_scraper_enabled: false,
  rag_sync_schedule: "0 2 * * *",
  run_at_startup: false,
  system_tray: true,
  keep_awake: true
};

let configExistenceChecked = false;
let configExistedBeforeSession = false;

async function readConfig(): Promise<AppConfig> {
  if (!configExistenceChecked) {
    configExistedBeforeSession = existsSync(APPDATA_CONFIG_PATH);
    configExistenceChecked = true;
  }

  try {
    await fs.mkdir(APPDATA_BASE_DIR, { recursive: true });
    const raw = await fs.readFile(APPDATA_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    try {
      await fs.writeFile(APPDATA_CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    } catch {
      /* best-effort */
    }
    return { ...DEFAULT_CONFIG };
  }
}

async function readPortOverride(): Promise<number | null> {
  try {
    const raw = await fs.readFile(APPDATA_PORT_FILE, "utf-8");
    const port = parseInt(raw.trim(), 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backend lifecycle.
// ---------------------------------------------------------------------------
let backendProcess: ChildProcess | null = null;
let resolvedBackendPort: number = DEFAULT_CONFIG.backend_port;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let systemTrayEnabled = DEFAULT_CONFIG.system_tray;
let keepAwakeBlockerId: number | null = null;
let latestBackendOnline = false;

function pingHealth(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/health", method: "GET", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function spawnBackend(initialPort: number): Promise<void> {
  const exe = backendExePath();
  if (!existsSync(exe)) {
    throw new Error(`backend.exe not found at ${exe}`);
  }
  await frontendLog(`spawning backend: ${exe}`);
  // Pin Hugging Face cache to the AppData/rag/models tree BEFORE the
  // backend boots so sentence-transformers and friends never write to
  // %USERPROFILE%\.cache (which is invisible to the uninstaller and
  // would re-download for every Windows user account).
  const hfHome = APPDATA_RAG_MODELS_DIR;
  backendProcess = spawn(exe, [], {
    detached: false,
    windowsHide: true,
    stdio: "ignore",
    cwd: path.dirname(exe),
    env: {
      ...process.env,
      ITAX_BACKEND_PORT: String(initialPort),
      HF_HOME: hfHome,
      TRANSFORMERS_CACHE: hfHome,
      SENTENCE_TRANSFORMERS_HOME: hfHome,
      HF_HUB_DISABLE_TELEMETRY: "1"
    }
  });
  backendProcess.on("exit", (code, signal) => {
    void frontendLog(`backend exited code=${code} signal=${signal}`);
    latestBackendOnline = false;
    updateTrayMenu();
    backendProcess = null;
  });
  backendProcess.on("error", (err) => {
    void frontendLog(`backend spawn error: ${err.message}`);
  });
}

async function waitForBackend(timeoutMs: number): Promise<number | null> {
  const start = Date.now();
  let port = resolvedBackendPort;
  while (Date.now() - start < timeoutMs) {
    const override = await readPortOverride();
    if (override) port = override;
    if (await pingHealth(port)) {
      resolvedBackendPort = port;
      return port;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function ensureBackendRunning(cfg: AppConfig): Promise<number> {
  const overridePort = await readPortOverride();
  resolvedBackendPort = overridePort ?? cfg.backend_port;

  // Already running? — short-circuit.
  if (await pingHealth(resolvedBackendPort)) {
    await frontendLog(`backend already healthy on :${resolvedBackendPort}`);
    latestBackendOnline = true;
    updateTrayMenu();
    return resolvedBackendPort;
  }

  if (app.isPackaged) {
    // Production: we own the backend lifecycle. Spawn the bundled
    // backend.exe and poll until it answers /health.
    await spawnBackend(resolvedBackendPort);
    const ready = await waitForBackend(30_000);
    if (ready === null) {
      latestBackendOnline = false;
      updateTrayMenu();
      throw new Error(
        `Backend failed to start. Check logs at ${path.join(APPDATA_LOGS_DIR, "backend.log")}`
      );
    }
    latestBackendOnline = true;
    updateTrayMenu();
    return ready;
  }

  // Dev: the developer runs the backend manually in another terminal.
  // We never spawn anything in dev. Just poll, and if it never answers,
  // surface a developer-friendly hint instead of a "backend crashed"
  // style message.
  await frontendLog("dev mode: not spawning backend; polling /health");
  const ready = await waitForBackend(30_000);
  if (ready === null) {
    latestBackendOnline = false;
    updateTrayMenu();
    throw new Error(
      "Backend not running. Start it manually with:\n" +
        "  cd backend && uvicorn main:app --host 127.0.0.1 --port 8000"
    );
  }
  latestBackendOnline = true;
  updateTrayMenu();
  return ready;
}

async function killBackend(): Promise<void> {
  if (!backendProcess || backendProcess.exitCode !== null) return;
  const proc = backendProcess;
  await frontendLog("sending SIGTERM to backend");
  try {
    proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  // Give it 3 seconds, then SIGKILL.
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve();
    }, 3000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
  backendProcess = null;
}

// ---------------------------------------------------------------------------
// UI plumbing.
// ---------------------------------------------------------------------------
function installApplicationMenu(): void {
  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    { role: "reload", label: "Reload", accelerator: "F5" }
  ];
  if (!app.isPackaged) {
    viewSubmenu.unshift({ role: "toggleDevTools", label: "Toggle DevTools", accelerator: "F12" });
  }
  const menu = Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [{ label: "Quit", accelerator: "Alt+F4", click: () => app.quit() }]
    },
    {
      label: "Edit",
      submenu: [
        { role: "cut", label: "Cut" },
        { role: "copy", label: "Copy" },
        { role: "paste", label: "Paste" }
      ]
    },
    { label: "View", submenu: viewSubmenu }
  ]);
  Menu.setApplicationMenu(menu);
}

function isAllowedNavigation(url: string): boolean {
  return (
    url.startsWith("file://") ||
    url.startsWith("http://127.0.0.1:5173/") ||
    url === "http://127.0.0.1:5173/"
  );
}

function showMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleMainWindow(): void {
  if (!mainWindow) {
    void createWindow(true);
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showMainWindow();
  }
}

function applyKeepAwake(enabled: boolean): void {
  if (enabled && keepAwakeBlockerId === null) {
    keepAwakeBlockerId = powerSaveBlocker.start("prevent-app-suspension");
  }
  if (!enabled && keepAwakeBlockerId !== null) {
    if (powerSaveBlocker.isStarted(keepAwakeBlockerId)) {
      powerSaveBlocker.stop(keepAwakeBlockerId);
    }
    keepAwakeBlockerId = null;
  }
}

function applyDesktopSettings(settings: DesktopSettings): void {
  systemTrayEnabled = settings.system_tray;
  app.setLoginItemSettings({ openAtLogin: settings.run_at_startup });
  applyKeepAwake(settings.keep_awake);
}

function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    {
      label: "Open ITax Reply Agent",
      click: showMainWindow
    },
    { type: "separator" },
    {
      label: `System Health: ${latestBackendOnline ? "Online" : "Offline"}`,
      enabled: false
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        tray?.destroy();
        tray = null;
        app.quit();
      }
    }
  ]);
}

function updateTrayMenu(): void {
  tray?.setContextMenu(buildTrayMenu());
}

function createTray(): void {
  if (tray) return;
  const iconPath = appIconPath();
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("ITax Reply Agent");
  tray.on("click", toggleMainWindow);
  tray.on("right-click", () => {
    updateTrayMenu();
    tray?.popUpContextMenu();
  });
  updateTrayMenu();
}

async function createWindow(showOnReady = true): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1120,
    minHeight: 720,
    title: "Income Tax Legal Reply Agent",
    icon: appIconPath(),
    backgroundColor: "#f7f7f7",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();

  mainWindow.on("close", (event) => {
    if (systemTrayEnabled && !isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.once("ready-to-show", () => {
    if (showOnReady) {
      showMainWindow();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
    }
  });

  if (app.isPackaged) {
    await mainWindow.loadFile(path.resolve(app.getAppPath(), "dist", "index.html"));
  } else {
    await mainWindow.loadURL(DEV_URL);
  }
}

// ---------------------------------------------------------------------------
// IPC channels — names and shapes are part of the public preload API.
// DO NOT rename these; they are referenced by frontend React code.
// ---------------------------------------------------------------------------
ipcMain.handle("open-output-folder", async (_event, outputFile: string) => {
  if (!outputFile || typeof outputFile !== "string") {
    // Open the default output folder if nothing specific was requested.
    const result = await shell.openPath(APPDATA_OUTPUT_DIR);
    return result ? { ok: false, error: result } : { ok: true };
  }
  // Validate the resolved folder stays inside BASE_DIR before handing it
  // to the OS shell — rejects path traversal (e.g. ..\..). The path.sep
  // suffix stops a sibling-prefix bypass (e.g. ...\ITaxReplyAgent_evil).
  const folder = path.resolve(path.dirname(outputFile));
  const base = path.resolve(APPDATA_BASE_DIR);
  if (folder !== base && !folder.startsWith(base + path.sep)) {
    await frontendLog(`open-output-folder: rejected path outside BASE_DIR: ${folder}`);
    const result = await shell.openPath(APPDATA_OUTPUT_DIR);
    return result ? { ok: false, error: result } : { ok: true };
  }
  const result = await shell.openPath(folder);
  return result ? { ok: false, error: result } : { ok: true };
});

ipcMain.handle("list-sessions", async () => {
  const dir = dataDir();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^session_.+\.json$/i.test(entry.name))
        .map(async (entry) => {
          const fullPath = path.join(dir, entry.name);
          const raw = await fs.readFile(fullPath, "utf-8");
          const parsed = JSON.parse(raw) as {
            session_id?: string;
            created_at?: string;
            updated_at?: string;
            turns?: unknown[];
          };
          const sessionId = parsed.session_id ?? entry.name.replace(/^session_|\.json$/gi, "");
          return {
            session_id: sessionId,
            created_at: parsed.created_at ?? "",
            updated_at: parsed.updated_at ?? parsed.created_at ?? "",
            turn_count: Array.isArray(parsed.turns) ? parsed.turns.length : 0
          };
        })
    );
    return sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  } catch {
    return [];
  }
});

ipcMain.handle("read-session", async (_event, sessionId: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error("Invalid session id.");
  }
  const filePath = path.join(dataDir(), `session_${sessionId}.json`);
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw);
});

ipcMain.handle("delete-session", (_event, sessionId: string) => {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return { success: false, error: "Invalid session id." };
    }
    const filePath = path.join(dataDir(), `session_${sessionId}.json`);
    if (!existsSync(filePath)) {
      return { success: false, error: "Session file not found." };
    }
    unlinkSync(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ---------------------------------------------------------------------------
// Settings IPC — used by the in-app Settings screen. These are EXTRA channels
// (additive); the four originals above are unchanged.
// ---------------------------------------------------------------------------
ipcMain.handle("get-config", async () => {
  return await readConfig();
});

ipcMain.handle("save-config", async (_event, next: Partial<AppConfig>) => {
  try {
    const current = await readConfig();
    const merged: AppConfig = { ...current, ...next };
    if (
      !Number.isInteger(merged.backend_port) ||
      merged.backend_port < 1024 ||
      merged.backend_port > 65535 ||
      !Number.isInteger(merged.ollama_port) ||
      merged.ollama_port < 1024 ||
      merged.ollama_port > 65535
    ) {
      return { success: false, error: "Ports must be integers in 1024–65535." };
    }
    if (merged.backend_port === merged.ollama_port) {
      return { success: false, error: "backend_port and ollama_port must differ." };
    }
    await fs.mkdir(APPDATA_BASE_DIR, { recursive: true });
    await fs.writeFile(APPDATA_CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
    // Restart the backend so it picks up the new port / config.
    await killBackend();
    await ensureBackendRunning(merged);
    return { success: true, config: merged, backend_port: resolvedBackendPort };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("open-logs-folder", async () => {
  await ensureLogsDir();
  const result = await shell.openPath(APPDATA_LOGS_DIR);
  return result ? { ok: false, error: result } : { ok: true };
});

ipcMain.handle("get-backend-port", () => resolvedBackendPort);

ipcMain.handle("apply-desktop-settings", (_event, settings: DesktopSettings) => {
  applyDesktopSettings({
    run_at_startup: Boolean(settings.run_at_startup),
    system_tray: Boolean(settings.system_tray),
    keep_awake: Boolean(settings.keep_awake)
  });
  return { success: true };
});

// ---------------------------------------------------------------------------
// Single-instance lock + app lifecycle.
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    installApplicationMenu();
    try {
      if (app.isPackaged) {
        // Seed the AppData tree before the backend boots so the very
        // first launch doesn't race with paths.ensure_dirs.
        await ensureAppDataDirs();
      }
      const cfg = await readConfig();
      applyDesktopSettings({
        run_at_startup: cfg.run_at_startup,
        system_tray: cfg.system_tray,
        keep_awake: cfg.keep_awake
      });
      createTray();
      await ensureBackendRunning(cfg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await frontendLog(`startup failed: ${message}`);
      dialog.showErrorBox("Income Tax Legal Reply Agent", message);
      app.quit();
      return;
    }
    await createWindow(!app.isPackaged || !systemTrayEnabled || !configExistedBeforeSession);
  });
}

app.on("window-all-closed", async () => {
  if (systemTrayEnabled && !isQuitting) {
    return;
  }
  await killBackend();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async (event) => {
  isQuitting = true;
  if (backendProcess && backendProcess.exitCode === null) {
    event.preventDefault();
    await killBackend();
    app.exit(0);
  }
});

app.on("activate", () => {
  if (mainWindow) {
    showMainWindow();
  } else {
    void createWindow(true);
  }
});
