import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Dropdown,
  FluentProvider,
  Label,
  Option,
  Slider,
  Spinner,
  Text,
  Textarea,
  webDarkTheme,
  webLightTheme
} from "@fluentui/react-components";
import {
  Add24Regular,
  ArrowClockwise24Regular,
  Delete24Regular,
  DocumentArrowDown24Regular,
  DocumentText24Regular,
  History24Regular,
  Library24Regular,
  Settings24Regular,
  Send24Regular,
  ShieldCheckmark24Regular,
  WeatherMoon24Regular,
  WeatherSunny24Regular
} from "@fluentui/react-icons";
import { HealthBanner } from "./components/HealthBanner";
import { RagStatusPanel } from "./components/RagStatusPanel";
import { ReplyViewer } from "./components/ReplyViewer";
import { SettingsPanel } from "./components/SettingsPanel";
import { UploadPanel } from "./components/UploadPanel";
import { generateReply, getHealth, getModels, pickDefaultModel } from "./lib/api";
import { formatSessionTime, latestTurn, newSessionId, sessionToHistory } from "./lib/session";
import type {
  GenerateResponse,
  HealthResponse,
  HistoryTurn,
  ModelInfo,
  SessionSummary,
  UploadError,
  UploadResponse
} from "./types/api";

const THEME_KEY = "itax-agent-theme";
const MODEL_KEY = "itax-agent-model";
const TEMP_KEY = "temperature";
const SESSION_KEY = "itax-agent-session-id";
const orangeLightTheme = {
  ...webLightTheme,
  colorBrandBackground: "#d97706",
  colorBrandBackgroundHover: "#b45309",
  colorBrandBackgroundPressed: "#92400e",
  colorBrandForeground1: "#d97706",
  colorBrandForeground2: "#92400e",
  colorBrandStroke1: "#d97706",
  colorBrandStroke2: "#d97706",
  colorCompoundBrandBackground: "#d97706",
  colorCompoundBrandBackgroundHover: "#b45309",
  colorCompoundBrandBackgroundPressed: "#92400e",
  colorCompoundBrandForeground1: "#d97706",
  colorCompoundBrandForeground1Hover: "#b45309",
  colorCompoundBrandForeground1Pressed: "#92400e",
  colorCompoundBrandStroke: "#d97706",
  colorCompoundBrandStrokeHover: "#b45309",
  colorCompoundBrandStrokePressed: "#92400e"
};

type GeneratePayload = {
  text: string;
  query: string;
  model: string;
  history: HistoryTurn[];
  session_id: string;
  temperature: number;
};

type GeneratePayloadWithSave = GeneratePayload & {
  save_output?: boolean;
};

type GenerateResult = Omit<GenerateResponse, "output_file"> & {
  output_file?: string | null;
};

function normalizeReply(result: GenerateResult): GenerateResponse {
  return {
    ...result,
    output_file: result.output_file ?? ""
  };
}

// Multi-file context-block hardening. Filenames and extracted text are
// interpolated into "=== FILE: <name> ===" / "=== END FILE: <name> ==="
// sub-delimiters inside the prompt. Either side could carry text that
// forges a boundary and smuggles instructions outside the document
// sandbox — sanitise both before composition.
const FILE_DELIMITER_RE = /===\s*(?:END\s+)?FILE\s*:[^\n]*===/gi;

function sanitizeFilenameForPrompt(name: string): string {
  return name
    .replace(FILE_DELIMITER_RE, "[filtered]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 200);
}

function sanitizeTextForPrompt(text: string): string {
  return text.replace(FILE_DELIMITER_RE, "[filtered]");
}

export function App() {
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem(THEME_KEY) === "dark");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthDismissed, setHealthDismissed] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem(MODEL_KEY) ?? "");
  const [temperature, setTemperature] = useState(() => {
    const stored = parseFloat(localStorage.getItem(TEMP_KEY) ?? "0.7");
    return Number.isNaN(stored) || stored === 0 ? 0.7 : stored;
  });
  const [sessionId, setSessionId] = useState(() => localStorage.getItem(SESSION_KEY) ?? newSessionId());
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [history, setHistory] = useState<HistoryTurn[]>([]);
  const [uploadedDocuments, setUploadedDocuments] = useState<UploadResponse[]>([]);
  const [uploadError, setUploadError] = useState<UploadError | null>(null);
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState("");
  const [reply, setReply] = useState<GenerateResponse | null>(null);
  const [lastGenerateRequest, setLastGenerateRequest] = useState<GeneratePayload | null>(null);
  const [generating, setGenerating] = useState(false);
  const [savingDocx, setSavingDocx] = useState(false);
  const [savedOutputFile, setSavedOutputFile] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null);
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<string | null>(null);
  const [deleteFailedSessionId, setDeleteFailedSessionId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"draft" | "rag" | "settings">("draft");
  // First-run embedding-model download banner. `null` = status not yet
  // probed; `true` = model already on disk (banner hidden); `false` =
  // download in flight (banner shown unless the user dismisses it).
  const [embeddingModelReady, setEmbeddingModelReady] = useState<boolean | null>(null);
  const [embeddingBannerDismissed, setEmbeddingBannerDismissed] = useState(false);
  const sessionListRef = useRef<HTMLDivElement | null>(null);

  const theme = darkMode ? webDarkTheme : orangeLightTheme;

  const refreshSessions = useCallback(async () => {
    try {
      const loaded = await window.localAgent.listSessions();
      setSessions(loaded);
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    localStorage.setItem(TEMP_KEY, String(temperature));
  }, [temperature]);

  useEffect(() => {
    localStorage.setItem(SESSION_KEY, sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (selectedModel) {
      localStorage.setItem(MODEL_KEY, selectedModel);
    }
  }, [selectedModel]);

  useEffect(() => {
    if (!savedOutputFile) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSavedOutputFile(null);
    }, 10000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [savedOutputFile]);

  useEffect(() => {
    let mounted = true;

    async function loadStartupData() {
      setHealthLoading(true);
      try {
        const [healthResult, modelResult] = await Promise.allSettled([getHealth(), getModels()]);
        if (!mounted) {
          return;
        }

        if (healthResult.status === "fulfilled") {
          setHealth(healthResult.value);
        } else {
          setHealth({
            ollama_running: false,
            primary_model: "qwen2.5:14b",
            fallback_model: "deepseek-r1:14b"
          });
        }

        if (modelResult.status === "fulfilled") {
          setModels(modelResult.value);
          setSelectedModel((current) => {
            const modelNames = new Set(modelResult.value.map((model) => model.name));
            return current && modelNames.has(current) ? current : pickDefaultModel(modelResult.value);
          });
        }
      } finally {
        if (mounted) {
          setHealthLoading(false);
        }
      }
    }

    void loadStartupData();
    void refreshSessions();

    return () => {
      mounted = false;
    };
  }, [refreshSessions]);

  // Poll the backend's /rag/status to drive the first-run "downloading
  // embedding model" banner. Runs immediately on mount, then every 10s,
  // and auto-stops once the model is reported available.
  useEffect(() => {
    let mounted = true;
    let timer: number | null = null;
    async function probe(): Promise<void> {
      try {
        const r = await fetch("http://127.0.0.1:8000/rag/status");
        if (!r.ok) return;
        const status = (await r.json()) as { embedding_model_available?: boolean };
        if (!mounted) return;
        setEmbeddingModelReady(!!status.embedding_model_available);
      } catch {
        /* backend may not be up yet; keep polling */
      }
    }
    void probe();
    timer = window.setInterval(() => {
      if (embeddingModelReady === true) {
        if (timer !== null) {
          window.clearInterval(timer);
          timer = null;
        }
        return;
      }
      void probe();
    }, 10_000);
    return () => {
      mounted = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [embeddingModelReady]);

  const generateDisabled = useMemo(() => {
    const hasUploadedText = uploadedDocuments.some((d) => d.text.trim().length > 0);
    return (
      generating ||
      uploading ||
      uploadError !== null ||
      !selectedModel ||
      (!hasUploadedText && !query.trim())
    );
  }, [generating, query, selectedModel, uploadError, uploadedDocuments, uploading]);

  function handleNewSession() {
    const nextId = newSessionId();
    setSessionId(nextId);
    setHistory([]);
    setUploadedDocuments([]);
    setUploadError(null);
    setUploading(false);
    setQuery("");
    setReply(null);
    setLastGenerateRequest(null);
    setSavedOutputFile(null);
    setSaveError(null);
    setGenerateError(null);
  }

  async function handleSelectSession(id: string) {
    setGenerateError(null);
    setUploadError(null);
    try {
      const session = await window.localAgent.readSession(id);
      const last = latestTurn(session);
      const loadedHistory = sessionToHistory(session);
      const priorHistory = session.turns.slice(0, -1).flatMap((turn) => [
        { role: "user" as const, content: turn.query },
        { role: "assistant" as const, content: turn.reply }
      ]);
      setSessionId(session.session_id);
      setHistory(loadedHistory);
      setQuery(last?.query ?? "");
      setUploadedDocuments(
        last?.notice_text
          ? [
              {
                filename: `Session ${session.session_id}`,
                text: last.notice_text
              }
            ]
          : []
      );
      setReply(
        last
          ? {
              reply: last.reply,
              model_used: last.model,
              output_file: "",
              session_id: session.session_id
            }
          : null
      );
      setLastGenerateRequest(
        last
          ? {
              text: last.notice_text ?? "",
              query: last.query,
              model: last.model,
              history: priorHistory,
              session_id: session.session_id,
              temperature
            }
          : null
      );
      setSavedOutputFile(null);
      setSaveError(null);
      if (last?.model) {
        setSelectedModel(last.model);
      }
    } catch {
      setGenerateError("Could not load selected session.");
    }
  }

  async function handleDeleteSession(id: string) {
    const api = (window as typeof window & {
      localAgent?: Window["localAgent"] & {
        deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
      };
    }).localAgent;

    try {
      const result = await api?.deleteSession(id);
      if (result?.success) {
        setSessions((current) => current.filter((session) => session.session_id !== id));
        setConfirmDeleteSessionId(null);
        if (id === sessionId) {
          handleNewSession();
        }
        return;
      }
    } catch {
      // Fall through to the inline failure state.
    }

    setDeleteFailedSessionId(id);
    window.setTimeout(() => {
      setDeleteFailedSessionId((current) => (current === id ? null : current));
    }, 3000);
  }

  async function handleGenerate() {
    // Single file → raw text (keeps the "# Sheet:" detection in prompts.py).
    // Multi-file → wrap each in FILE delimiters so the model can keep
    // documents distinct; sanitise both filename and text so a poisoned
    // entry cannot forge a sub-boundary inside the document block.
    const combinedText =
      uploadedDocuments.length === 1
        ? uploadedDocuments[0].text
        : uploadedDocuments
            .map((d) => {
              const safeName = sanitizeFilenameForPrompt(d.filename);
              const safeText = sanitizeTextForPrompt(d.text);
              return `=== FILE: ${safeName} ===\n${safeText}\n=== END FILE: ${safeName} ===`;
            })
            .join("\n\n");

    const request: GeneratePayload = {
      text: combinedText,
      query,
      model: selectedModel,
      history,
      session_id: sessionId,
      temperature
    };

    setGenerating(true);
    setGenerateError(null);
    setSavedOutputFile(null);
    setSaveError(null);

    try {
      const result = await generateReply({ ...request, save_output: false } as GeneratePayloadWithSave);
      const normalized = normalizeReply(result);
      setReply(normalized);
      setLastGenerateRequest(request);
      setSessionId(result.session_id);
      setHistory((current) => [
        ...current,
        { role: "user", content: query },
        { role: "assistant", content: result.reply }
      ]);
      await refreshSessions();
    } catch (error) {
      setGenerateError(error instanceof Error ? error.message : "Generation failed.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleSaveDocx() {
    if (!lastGenerateRequest) return;

    setSavingDocx(true);
    setSaveError(null);
    try {
      const result = await generateReply({
        ...lastGenerateRequest,
        save_output: true
      } as GeneratePayloadWithSave);
      const outputFile = (result as GenerateResult).output_file;
      if (!outputFile) {
        throw new Error("Missing output file.");
      }
      setSavedOutputFile(outputFile);
    } catch {
      setSavedOutputFile(null);
      setSaveError("Save failed");
    } finally {
      setSavingDocx(false);
    }
  }

  async function handleRegenerate() {
    if (!lastGenerateRequest) return;

    setGenerating(true);
    setGenerateError(null);
    setSavedOutputFile(null);
    setSaveError(null);
    try {
      const result = await generateReply({
        ...lastGenerateRequest,
        save_output: false
      } as GeneratePayloadWithSave);
      const normalized = normalizeReply(result);
      setReply(normalized);
      setSessionId(result.session_id);
      await refreshSessions();
    } catch (error) {
      setGenerateError(error instanceof Error ? error.message : "Generation failed.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <FluentProvider theme={theme}>
      <div className={`appShell ${darkMode ? "themeDark" : "themeLight"}`}>
        <header className="topBar">
          <div className="brandCluster">
            <div className={`statusPill ${health?.ollama_running ? "online" : "offline"}`}>
              <span aria-hidden="true" />
              <Text size={200}>
                {healthLoading
                  ? "System Health: Checking"
                  : health?.ollama_running
                    ? "System Health: Online"
                    : "System Health: Offline"}
              </Text>
            </div>
          </div>
          <div className="topActions">
            <Button appearance="subtle" icon={<ShieldCheckmark24Regular />} aria-label="Health status" />
            <Button
              appearance="subtle"
              icon={darkMode ? <WeatherMoon24Regular /> : <WeatherSunny24Regular />}
              aria-label="Toggle theme"
              onClick={() => setDarkMode((current) => !current)}
            />
          </div>
        </header>

        <aside className="sidebar">
          <div className="sidebarHeader">
            <Text as="h1" weight="semibold" size={700}>
              TaxDraft India
            </Text>
          </div>

          <nav className="sidebarNav" aria-label="Workspace navigation">
            <button
              className={`navItem ${activeView === "draft" ? "active" : ""}`}
              type="button"
              onClick={() => setActiveView("draft")}
            >
              <DocumentText24Regular />
              <span>Drafting Session</span>
            </button>
            <button
              className={`navItem ${activeView === "rag" ? "active" : ""}`}
              type="button"
              onClick={() => setActiveView("rag")}
            >
              <Library24Regular />
              <span>RAG Library</span>
            </button>
            <button
              className={`navItem ${activeView === "settings" ? "active" : ""}`}
              type="button"
              onClick={() => setActiveView("settings")}
            >
              <Settings24Regular />
              <span>Settings</span>
            </button>
          </nav>

          <div className="sessionList" ref={sessionListRef} tabIndex={-1}>
            {sessions.length === 0 ? (
              <div className="emptyState">
                <History24Regular />
                <Text size={200}>No saved sessions yet.</Text>
              </div>
            ) : (
              sessions.map((session) => (
                <div
                  className={`sessionItem ${session.session_id === sessionId ? "active" : ""}`}
                  key={session.session_id}
                  role="button"
                  tabIndex={0}
                  onClick={() => void handleSelectSession(session.session_id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      void handleSelectSession(session.session_id);
                    }
                  }}
                  onMouseEnter={() => setHoveredSessionId(session.session_id)}
                  onMouseLeave={() => setHoveredSessionId((current) => (current === session.session_id ? null : current))}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <span className="sessionId" style={{ display: "block" }}>
                        {session.session_id}
                      </span>
                      <span className="sessionMeta" style={{ display: "block" }}>
                        {formatSessionTime(session.updated_at || session.created_at)}
                      </span>
                      <span className="sessionMeta" style={{ display: "block" }}>
                        {session.turn_count} turn{session.turn_count === 1 ? "" : "s"}
                      </span>
                    </div>
                    <Button
                      appearance="subtle"
                      aria-label={`Delete session ${session.session_id}`}
                      icon={<Delete24Regular style={{ fontSize: "16px" }} />}
                      size="small"
                      style={{
                        color: "var(--colorNeutralForeground3)",
                        opacity: hoveredSessionId === session.session_id ? 1 : 0,
                        transition: "opacity 120ms ease"
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setConfirmDeleteSessionId(session.session_id);
                      }}
                    />
                  </div>

                  {confirmDeleteSessionId === session.session_id && (
                    <div
                      style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "8px", width: "100%" }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Text size={200}>Delete?</Text>
                      <Button size="small" appearance="primary" onClick={() => void handleDeleteSession(session.session_id)}>
                        Yes
                      </Button>
                      <Button size="small" appearance="secondary" onClick={() => setConfirmDeleteSessionId(null)}>
                        Cancel
                      </Button>
                    </div>
                  )}

                  {deleteFailedSessionId === session.session_id && (
                    <Text size={200} style={{ color: "var(--colorPaletteRedForeground1)", marginTop: "6px" }}>
                      Delete failed
                    </Text>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="sidebarFooter">
            <Button appearance="primary" icon={<Add24Regular />} onClick={handleNewSession}>
              New Draft
            </Button>
          </div>
        </aside>

        <main className="mainPane">
          {embeddingModelReady === false && !embeddingBannerDismissed && (
            <div
              role="status"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "10px 14px",
                margin: "12px 30px 0",
                borderRadius: "6px",
                background: "var(--colorPaletteYellowBackground2)",
                border: "1px solid var(--colorPaletteYellowBorder1)"
              }}
            >
              <Spinner size="tiny" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text weight="semibold" size={300}>
                  First run: downloading AI embedding model (~90MB)
                </Text>
                <Text size={200} style={{ display: "block" }}>
                  Internet required — this happens once only. RAG citation
                  features will activate when complete.
                </Text>
              </div>
              <Button
                appearance="subtle"
                size="small"
                onClick={() => setEmbeddingBannerDismissed(true)}
              >
                Dismiss
              </Button>
            </div>
          )}
          <HealthBanner
            dismissed={healthDismissed}
            health={health}
            loading={healthLoading}
            onDismiss={() => setHealthDismissed(true)}
          />

          {activeView === "draft" && (
            <div className="workspaceGrid">
              <div className="leftColumn">
                <div className="paneHeader">
                  <div>
                    <Text as="h2" weight="semibold" size={600}>
                      Input Parameters
                    </Text>
                    <Text className="mutedText">Notice upload, query, model and drafting controls</Text>
                  </div>
                  <Text className="eyebrow">v1.0 local</Text>
                </div>

                <UploadPanel
                  uploadedDocuments={uploadedDocuments}
                  onAddDocuments={(documents) => {
                    setUploadedDocuments((prev) => {
                      // Merge by filename so re-uploading the same name
                      // replaces (rather than duplicates) the entry.
                      const map = new Map(prev.map((d) => [d.filename, d]));
                      for (const d of documents) map.set(d.filename, d);
                      return Array.from(map.values());
                    });
                    setGenerateError(null);
                  }}
                  onRemoveDocument={(filename) => {
                    setUploadedDocuments((prev) =>
                      prev.filter((d) => d.filename !== filename)
                    );
                  }}
                  onUploadErrorChange={setUploadError}
                  onUploadingChange={setUploading}
                />

                <section className="panel composerPanel">
                  <div className="panelHeader">
                    <div>
                      <Text as="h2" weight="semibold" size={500}>
                        Legal Query / Instructions
                      </Text>
                      <Text size={200} className="mutedText">
                        Describe what reply you need
                      </Text>
                    </div>
                  </div>

                  <Textarea
                    id="query"
                    resize="vertical"
                    rows={6}
                    value={query}
                    onChange={(_, data) => setQuery(data.value)}
                    placeholder="Draft a formal para-wise response to the notice..."
                  />

                  <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", width: "100%" }}>
                    <div className="controlField" style={{ width: "200px", minWidth: 0, flex: "0 0 200px" }}>
                      <Label htmlFor="model">Model</Label>
                      <Dropdown
                        id="model"
                        style={{ width: "200px", minWidth: 0, maxWidth: "200px" }}
                        selectedOptions={selectedModel ? [selectedModel] : []}
                        value={selectedModel || "No models found"}
                        onOptionSelect={(_, data) => setSelectedModel(data.optionValue ?? "")}
                      >
                        {models.map((model) => (
                          <Option key={model.name} value={model.name}>
                            {model.name}
                          </Option>
                        ))}
                      </Dropdown>
                    </div>

                  <div className="controlField" style={{ flex: 1, minWidth: 0 }}>
                    <div className="sliderHeader">
                      <Label htmlFor="temperature">Temperature</Label>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", width: "100%", minWidth: 0 }}>
                      <Slider
                        id="temperature"
                        min={0}
                          max={1}
                          step={0.1}
                        value={temperature}
                        onChange={(_, data) => setTemperature(data.value)}
                      />
                      <Text size={200} style={{ marginLeft: "8px", minWidth: "24px", textAlign: "right" }}>
                        {temperature.toFixed(1)}
                      </Text>
                    </div>
                  </div>
                  </div>

                  {generateError && (
                    <div className="generateError" role="alert">
                      {generateError}
                    </div>
                  )}

                  <div className="submitRow">
                    <Button
                      appearance="primary"
                      disabled={generateDisabled}
                      icon={<Send24Regular />}
                      onClick={() => void handleGenerate()}
                    >
                      {generating ? "Generating..." : "Generate Reply"}
                    </Button>
                  </div>
                </section>
              </div>

              <div style={{ display: "flex", minWidth: 0, minHeight: 0, flexDirection: "column", overflow: "hidden" }}>
                <ReplyViewer generating={generating} reply={reply} />

                <div
                  style={{
                    display: "grid",
                    gap: "10px",
                    padding: "14px 30px 24px",
                    background: "var(--surface)"
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "10px",
                      opacity: reply ? 1 : 0.4,
                      transition: "opacity 0.3s ease"
                    }}
                  >
                    <Button
                      appearance="primary"
                      disabled={!reply || savingDocx || generating || !lastGenerateRequest}
                      icon={savingDocx ? <Spinner size="tiny" /> : <DocumentArrowDown24Regular />}
                      style={{
                        color: "#ffffff",
                        background: darkMode ? "var(--primary-action)" : "#d97706",
                        borderColor: darkMode ? "var(--primary-action)" : "#d97706",
                        cursor: reply ? "pointer" : "not-allowed"
                      }}
                      onClick={() => void handleSaveDocx()}
                    >
                      {savingDocx ? "Saving..." : "Save as .docx"}
                    </Button>
                    <Button
                      appearance="secondary"
                      disabled={!reply || savingDocx || generating || !lastGenerateRequest}
                      icon={<ArrowClockwise24Regular />}
                      style={{
                        borderColor: darkMode ? "var(--primary-action)" : "#d97706",
                        color: darkMode ? "var(--primary)" : "#92400e",
                        cursor: reply ? "pointer" : "not-allowed"
                      }}
                      onClick={() => void handleRegenerate()}
                    >
                      Regenerate
                    </Button>
                  </div>

                  {savedOutputFile && (
                    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                      <Text size={200} style={{ color: "var(--colorPaletteGreenForeground1)" }}>
                        Saved to {savedOutputFile}
                      </Text>
                      <Button
                        appearance="transparent"
                        size="small"
                        onClick={() => void window.localAgent.openOutputFolder(savedOutputFile)}
                      >
                        Open folder
                      </Button>
                    </div>
                  )}

                  {saveError && (
                    <Text size={200} style={{ color: "var(--colorPaletteRedForeground1)" }}>
                      {saveError}
                    </Text>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeView === "rag" && (
            <section className="fullViewPanel">
              <RagStatusPanel />
            </section>
          )}

          {activeView === "settings" && (
            <section className="fullViewPanel">
              <SettingsPanel />
            </section>
          )}
        </main>
      </div>
    </FluentProvider>
  );
}
