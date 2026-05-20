import { useEffect, useState } from "react";
import {
  Button,
  Spinner,
  Text
} from "@fluentui/react-components";

/**
 * RAG status + manual-ingest panel — additive component.
 *
 * Phase 2 RAG, post-pivot to manual ingestion. Displays:
 *
 *   * The absolute path of the docs folder where the user should drop
 *     CBDT circulars / notifications / press releases / Acts as PDFs
 *     (or DOCX / TXT).
 *   * Sync timestamps + counts pulled from `GET /rag/status`.
 *   * A "Sync now" button that triggers `POST /rag/sync` (background).
 *
 * Like SettingsPanel, this component is shipped *additive*. It is not
 * wired into App.tsx by default — drop `<RagStatusPanel />` into the
 * sidebar (or a dedicated tab) when you want it visible. The component
 * has no dependencies on App.tsx state.
 */

const API_BASE = "http://127.0.0.1:8000";

type RagStatus = {
  last_sync: string | null;
  docs_total: number;
  docs_added_last_run: number;
  superseded_docs: number;
  last_sync_status: "success" | "partial" | "failed" | "never";
  errors: string[];
  next_scheduled_sync: string | null;
  embedding_model_available: boolean;
  chunks_total: number;
};

type RagDocument = {
  title: string;
  type: string;
  cbdt_ref: string;
  effective_date: string;
  date_fetched: string;
  source_url: string;
  is_superseded: boolean;
  superseded_by: string;
  chunk_count: number;
};

type DocsFolder = {
  path: string;
  exists: boolean;
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let detail: string | undefined;
    try {
      detail = ((await r.json()) as { detail?: string }).detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function RagStatusPanel() {
  const [folder, setFolder] = useState<DocsFolder | null>(null);
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [documents, setDocuments] = useState<RagDocument[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [reindexing, setReindexing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setError(null);
    try {
      const [s, f, d] = await Promise.all([
        fetchJson<RagStatus>(`${API_BASE}/rag/status`),
        fetchJson<DocsFolder>(`${API_BASE}/rag/docs-folder`),
        fetchJson<RagDocument[]>(`${API_BASE}/rag/documents`)
      ]);
      setStatus(s);
      setFolder(f);
      setDocuments(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refreshStatusAndDocuments(): Promise<RagStatus> {
    const [s, d] = await Promise.all([
      fetchJson<RagStatus>(`${API_BASE}/rag/status`),
      fetchJson<RagDocument[]>(`${API_BASE}/rag/documents`)
    ]);
    setStatus(s);
    setDocuments(d);
    return s;
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    refresh().finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  async function handleSync(): Promise<void> {
    const previousStatus = status?.last_sync_status ?? "never";
    const previousLastSync = status?.last_sync ?? null;

    setSyncing(true);
    setInfo("Sync started — this may take several minutes");
    setError(null);
    try {
      await fetchJson<{ status: string; message: string }>(
        `${API_BASE}/rag/sync`,
        { method: "POST" }
      );

      let latestStatus: RagStatus | null = null;
      do {
        await wait(5000);
        latestStatus = await refreshStatusAndDocuments();
      } while (
        latestStatus.last_sync_status === previousStatus &&
        latestStatus.last_sync === previousLastSync
      );

      setInfo("Sync complete.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInfo(null);
    } finally {
      setSyncing(false);
    }
  }

  async function handleReindex(): Promise<void> {
    const confirmed = window.confirm("This will re-index all documents.\nContinue?");
    if (!confirmed) return;

    setReindexing(true);
    setInfo("Re-index started. Reload status in a few seconds.");
    setError(null);
    try {
      await fetchJson<{ status: string; message: string }>(
        `${API_BASE}/rag/reindex`,
        { method: "POST" }
      );
      await refresh();
      window.setTimeout(() => {
        void refresh();
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInfo(null);
    } finally {
      setReindexing(false);
    }
  }

  async function copyFolderPath(): Promise<void> {
    if (!folder?.path) return;
    try {
      await navigator.clipboard.writeText(folder.path);
      setInfo("Folder path copied to clipboard.");
      window.setTimeout(() => setInfo((c) => (c?.startsWith("Folder") ? null : c)), 2500);
    } catch {
      setError("Could not copy to clipboard.");
    }
  }

  if (loading) {
    return (
      <section className="panel ragPanel">
        <Spinner label="Loading RAG status..." />
      </section>
    );
  }

  return (
    <section className="panel ragPanel" aria-label="RAG status">
      <Text as="h2" weight="semibold" size={500}>
        Reference Library (RAG)
      </Text>
      <Text size={200} className="mutedText">
        Legal documents auto-synced daily via Indian Kanoon API.
      </Text>

      <div
        style={{
          display: "grid",
          gap: 12,
          marginTop: 16,
          padding: 16,
          border: "1px solid var(--outline)",
          borderRadius: 8,
          background: "var(--surface-high, rgba(255, 255, 255, 0.04))"
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 12px", alignItems: "center" }}>
          <span
            aria-hidden="true"
            style={{
              width: 9,
              height: 9,
              borderRadius: "999px",
              background:
                status?.last_sync_status === "failed"
                  ? "var(--colorPaletteRedForeground1, #dc2626)"
                  : status?.last_sync_status === "success"
                    ? "var(--colorPaletteGreenForeground1, #15803d)"
                    : "var(--colorPaletteYellowForeground2, #b45309)"
            }}
          />
          <Text weight="semibold">
            Last sync: {formatTimestamp(status?.last_sync ?? null)}
            {status?.last_sync_status && status.last_sync_status !== "never"
              ? ` (${status.last_sync_status})`
              : ""}
          </Text>

          <Text weight="semibold">Documents indexed:</Text>
          <Text>{status?.docs_total ?? 0}</Text>

          <Text weight="semibold">Chunks in vector store:</Text>
          <Text>{status?.chunks_total ?? 0}</Text>

          <Text weight="semibold">Added last run:</Text>
          <Text>{status?.docs_added_last_run ?? 0}</Text>

          <Text weight="semibold">Next scheduled sync:</Text>
          <Text>{formatTimestamp(status?.next_scheduled_sync ?? null)}</Text>

          {(status?.superseded_docs ?? 0) > 0 && (
            <>
              <Text weight="semibold">Superseded documents:</Text>
              <Text style={{ color: "var(--colorPaletteMarigoldForeground2, #8a6d3b)" }}>
                {status?.superseded_docs ?? 0}
              </Text>
            </>
          )}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Button
            appearance="primary"
            disabled={syncing || reindexing || !status?.embedding_model_available}
            onClick={() => void handleSync()}
          >
            {syncing ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Spinner size="tiny" />
                Syncing...
              </span>
            ) : (
              "Sync now"
            )}
          </Button>
          <Button
            appearance="secondary"
            disabled={syncing || reindexing || !status?.embedding_model_available}
            onClick={() => void handleReindex()}
          >
            {reindexing ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Spinner size="tiny" />
                Re-indexing...
              </span>
            ) : (
              "Re-index"
            )}
          </Button>
          <Button appearance="secondary" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
      </div>

      {!status?.embedding_model_available && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            background: "var(--colorPaletteYellowBackground2)",
            borderRadius: 4
          }}
        >
          <Text size={200}>
            Embedding model not yet downloaded. Run sync once with internet to download
            the model (~90 MB). After that, all processing is offline.
          </Text>
        </div>
      )}

      <details style={{ marginTop: 12 }}>
        <summary>
          <Text>➕ Add custom documents (optional)</Text>
        </summary>
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <Text size={200} className="mutedText">
            Drop additional PDFs (CBDT circulars, notifications) for manual indexing alongside auto-synced content.
          </Text>
          <div
            className="monoBox"
            style={{
              padding: 10,
              fontFamily: "Consolas, monospace",
              fontSize: 13,
              wordBreak: "break-all"
            }}
          >
            {folder?.path ?? "(unknown)"}
          </div>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <Button appearance="secondary" disabled={!folder?.path} onClick={() => void copyFolderPath()}>
              Copy path
            </Button>
            <Text size={200} className="mutedText">
              Then click <strong>Sync</strong> to index them.
            </Text>
          </div>
        </div>
      </details>

      {status?.errors && status.errors.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary>
            <Text>{status.errors.length} error(s) on last sync</Text>
          </summary>
          <ul style={{ marginTop: 6, paddingLeft: 20 }}>
            {status.errors.slice(0, 20).map((e, i) => (
              <li key={i}>
                <Text size={200}>{e}</Text>
              </li>
            ))}
          </ul>
        </details>
      )}

      {documents.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary>
            <Text>{documents.length} indexed document(s)</Text>
          </summary>
          <div style={{ display: "grid", gap: 8, marginTop: 8, maxHeight: 260, overflowY: "auto" }}>
            {documents.map((doc) => (
              <div
                key={doc.source_url}
                style={{
                  border: "1px solid var(--outline)",
                  borderRadius: 6,
                  padding: 10,
                  color: doc.is_superseded ? "var(--colorNeutralForeground3, #6b7280)" : undefined,
                  background: doc.is_superseded
                    ? "var(--colorNeutralBackground2, rgba(120, 120, 120, 0.08))"
                    : undefined
                }}
              >
                <Text
                  weight="semibold"
                  style={{
                    display: "block",
                    textDecoration: doc.is_superseded ? "line-through" : undefined
                  }}
                >
                  {doc.title || doc.source_url}
                </Text>
                <Text size={200} className="mutedText">
                  {[doc.type, doc.cbdt_ref, `${doc.chunk_count} chunks`].filter(Boolean).join(" | ")}
                </Text>
                {doc.is_superseded && doc.superseded_by && (
                  <Text
                    size={200}
                    style={{
                      display: "block",
                      marginTop: 4,
                      color: "var(--colorNeutralForeground3, #6b7280)"
                    }}
                  >
                    Superseded by: {doc.superseded_by}
                  </Text>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      {info && !error && (
        <div style={{ marginTop: 12, color: "var(--colorPaletteGreenForeground1)" }}>
          <Text>{info}</Text>
        </div>
      )}
      {error && (
        <div style={{ marginTop: 12, color: "var(--colorPaletteRedForeground1)" }}>
          <Text>{error}</Text>
        </div>
      )}
    </section>
  );
}
