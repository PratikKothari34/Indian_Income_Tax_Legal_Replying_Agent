import { useEffect, useState } from "react";
import {
  Button,
  Field,
  Input,
  Label,
  Spinner,
  Switch,
  Text
} from "@fluentui/react-components";
import { Eye20Regular, EyeOff20Regular } from "@fluentui/react-icons";

/**
 * Settings panel — additive component. Not wired into App.tsx by default
 * to keep the existing UI logic untouched. To enable, import and render
 * this component from the sidebar in App.tsx:
 *
 *     <SettingsPanel />
 *
 * Reads + writes config.json via window.localAgent IPC. On save the
 * Electron main process restarts the backend subprocess so the new port
 * / model path takes effect.
 */
type Config = {
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
type DesktopSettings = Pick<Config, "run_at_startup" | "system_tray" | "keep_awake">;

type SaveResult = {
  success: boolean;
  error?: string;
  backend_port?: number;
};

type LocalAgentExtras = {
  getConfig?: () => Promise<Config>;
  saveConfig?: (next: Partial<Config>) => Promise<SaveResult>;
  applyDesktopSettings?: (settings: DesktopSettings) => Promise<{ success: boolean; error?: string }>;
  openLogsFolder?: () => Promise<{ ok: boolean; error?: string }>;
  getBackendPort?: () => Promise<number>;
};

function localAgent(): (Window["localAgent"] & LocalAgentExtras) | undefined {
  return (window as typeof window & { localAgent?: Window["localAgent"] & LocalAgentExtras }).localAgent;
}

function normalizeConfig(cfg: Config): Config {
  return {
    ...cfg,
    indiankanoon_token: cfg.indiankanoon_token ?? "",
    run_at_startup: cfg.run_at_startup ?? false,
    system_tray: cfg.system_tray ?? true,
    keep_awake: cfg.keep_awake ?? true
  };
}

export function SettingsPanel() {
  const [config, setConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [showIkToken, setShowIkToken] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    const api = localAgent();
    if (!api?.getConfig) {
      setError("Settings IPC unavailable. Update the Electron preload.");
      return;
    }
    setLoading(true);
    api
      .getConfig()
      .then((cfg) => {
        if (!active) return;
        const normalized = normalizeConfig(cfg);
        setConfig(normalized);
        setDraft(normalized);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function update<K extends keyof Config>(key: K, value: Config[K]): void {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
  }

  async function handleSave(): Promise<void> {
    const api = localAgent();
    if (!api?.saveConfig || !draft) return;
    setError(null);
    setInfo("Saving and restarting backend...");
    setSaving(true);
    try {
      const next = { ...draft, indiankanoon_token: draft.indiankanoon_token ?? "" };
      const result = await api.saveConfig(next);
      if (!result.success) {
        setError(result.error ?? "Failed to save settings.");
        setInfo(null);
        return;
      }
      setConfig(next);
      setInfo(
        `Settings saved. Backend running on port ${
          result.backend_port ?? next.backend_port
        }.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInfo(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDesktopToggle<K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]): Promise<void> {
    const api = localAgent();
    if (!api?.saveConfig || !draft) return;

    const next = { ...draft, [key]: value };
    const desktopSettings: DesktopSettings = {
      run_at_startup: next.run_at_startup,
      system_tray: next.system_tray,
      keep_awake: next.keep_awake
    };

    setDraft(next);
    setError(null);
    setInfo("Saving desktop settings...");
    setSaving(true);
    try {
      const result = await api.saveConfig(next);
      if (!result.success) {
        setError(result.error ?? "Failed to save settings.");
        setInfo(null);
        return;
      }

      const applyResult = await api.applyDesktopSettings?.(desktopSettings);
      if (applyResult && !applyResult.success) {
        setError(applyResult.error ?? "Failed to apply desktop settings.");
        setInfo(null);
        return;
      }

      setConfig(next);
      setInfo("Desktop settings updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInfo(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleOpenLogs(): Promise<void> {
    const api = localAgent();
    if (!api?.openLogsFolder) return;
    const result = await api.openLogsFolder();
    if (!result.ok) {
      setError(result.error ?? "Could not open logs folder.");
    }
  }

  function validate(d: Config | null): string | null {
    if (!d) return null;
    const ports = [d.ollama_port, d.backend_port];
    for (const p of ports) {
      if (!Number.isInteger(p) || p < 1024 || p > 65535) {
        return "Ports must be integers in 1024 - 65535.";
      }
    }
    if (d.ollama_port === d.backend_port) {
      return "Backend port and Ollama port must differ.";
    }
    if (!d.ollama_host.trim()) {
      return "Ollama host is required.";
    }
    if (!d.model_storage_path.trim()) {
      return "Model storage path is required.";
    }
    return null;
  }

  if (loading || !draft) {
    return (
      <section className="panel settingsPanel">
        {error ? (
          <Text style={{ color: "var(--colorPaletteRedForeground1)" }}>{error}</Text>
        ) : (
          <Spinner label="Loading settings..." />
        )}
      </section>
    );
  }

  const validationMessage = validate(draft);
  const dirty =
    !!config &&
    (config.ollama_host !== draft.ollama_host ||
      config.ollama_port !== draft.ollama_port ||
      config.backend_port !== draft.backend_port ||
      config.model_storage_path !== draft.model_storage_path ||
      config.indiankanoon_token !== draft.indiankanoon_token ||
      config.incometax_pdf_scraper_enabled !== draft.incometax_pdf_scraper_enabled ||
      config.rag_sync_schedule !== draft.rag_sync_schedule ||
      config.run_at_startup !== draft.run_at_startup ||
      config.system_tray !== draft.system_tray ||
      config.keep_awake !== draft.keep_awake);

  return (
    <section className="panel settingsPanel" aria-label="Settings">
      <Text as="h2" weight="semibold" size={500}>
        Settings
      </Text>
      <Text size={200} className="mutedText">
        Stored at %LOCALAPPDATA%\ITaxReplyAgent\config.json. Saving restarts the backend.
      </Text>

      <Field label="Ollama host" style={{ marginTop: 12 }}>
        <Input
          value={draft.ollama_host}
          onChange={(_, data) => update("ollama_host", data.value)}
        />
      </Field>

      <Field label="Ollama port" style={{ marginTop: 12 }}>
        <Input
          type="number"
          value={String(draft.ollama_port)}
          onChange={(_, data) => update("ollama_port", parseInt(data.value, 10) || 0)}
        />
      </Field>

      <Field label="Backend port" style={{ marginTop: 12 }}>
        <Input
          type="number"
          value={String(draft.backend_port)}
          onChange={(_, data) => update("backend_port", parseInt(data.value, 10) || 0)}
        />
      </Field>

      <Field
        label="Indian Kanoon API Token"
        hint="Required for automatic law updates. Get free token at api.indiankanoon.org (non-commercial use)"
        style={{ marginTop: 12 }}
      >
        <Input
          type={showIkToken ? "text" : "password"}
          value={draft.indiankanoon_token}
          onChange={(_, data) => update("indiankanoon_token", data.value)}
          placeholder="Enter your IK API token"
          contentAfter={
            <Button
              appearance="transparent"
              aria-label={showIkToken ? "Hide Indian Kanoon API token" : "Show Indian Kanoon API token"}
              icon={showIkToken ? <EyeOff20Regular /> : <Eye20Regular />}
              size="small"
              style={{ border: 0, minWidth: 28, padding: 0 }}
              onClick={() => setShowIkToken((current) => !current)}
            />
          }
        />
      </Field>

      <Field label="Model storage path" style={{ marginTop: 12 }}>
        <Input
          value={draft.model_storage_path}
          onChange={(_, data) => update("model_storage_path", data.value)}
        />
      </Field>

      <div style={{ display: "grid", gap: 12, marginTop: 20 }}>
        <Text weight="semibold">Desktop Settings</Text>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ display: "grid", gap: 2 }}>
            <Text weight="semibold">Run on startup</Text>
            <Text size={200} className="mutedText">
              Automatically start ITax Reply Agent when you log in
            </Text>
          </div>
          <Switch
            checked={draft.run_at_startup}
            disabled={saving}
            onChange={(_, data) => void handleDesktopToggle("run_at_startup", data.checked)}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ display: "grid", gap: 2 }}>
            <Text weight="semibold">System tray</Text>
            <Text size={200} className="mutedText">
              Keep app running in system tray when window is closed
            </Text>
          </div>
          <Switch
            checked={draft.system_tray}
            disabled={saving}
            onChange={(_, data) => void handleDesktopToggle("system_tray", data.checked)}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ display: "grid", gap: 2 }}>
            <Text weight="semibold">Keep computer awake</Text>
            <Text size={200} className="mutedText">
              Prevent computer from sleeping while app is open so scheduled sync can run. Display can still turn off.
            </Text>
          </div>
          <Switch
            checked={draft.keep_awake}
            disabled={saving}
            onChange={(_, data) => void handleDesktopToggle("keep_awake", data.checked)}
          />
        </div>
      </div>

      {validationMessage && (
        <Label style={{ color: "var(--colorPaletteRedForeground1)", marginTop: 12 }}>
          {validationMessage}
        </Label>
      )}
      {error && (
        <Label style={{ color: "var(--colorPaletteRedForeground1)", marginTop: 12 }}>
          {error}
        </Label>
      )}
      {info && !error && (
        <Label style={{ color: "var(--colorPaletteGreenForeground1)", marginTop: 12 }}>
          {info}
        </Label>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <Button
          appearance="primary"
          disabled={saving || !dirty || validationMessage !== null}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
        <Button
          appearance="secondary"
          disabled={saving}
          onClick={() => void handleOpenLogs()}
        >
          View Logs
        </Button>
      </div>
    </section>
  );
}
