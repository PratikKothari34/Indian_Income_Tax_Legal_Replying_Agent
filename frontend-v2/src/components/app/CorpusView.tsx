/**
 * Corpus — what is indexed, when it last synced, and the two buttons that
 * change that.
 *
 * ## The polling problem
 *
 * `POST /rag/sync` and `POST /rag/reindex` are both fire-and-forget: they
 * return `{status:"started"}` immediately and the work happens on a background
 * task. So "is it still running?" is answered by polling `GET /rag/status`.
 *
 * `sync_in_progress` is the authority, and it covers both jobs — reindex runs
 * under the same exclusive guard (`backend-rs/src/routes/rag.rs`), so the flag
 * is true for a rebuild as well as a sync.
 *
 * The one thing the flag cannot do is tell "not started yet" from "finished":
 * it is false in the gap between the POST returning and the spawned task
 * taking the guard. Reading that false as completion would announce success
 * the instant a job began. So a job is *armed* by first observing the flag
 * true, and only an armed job may be completed by seeing it false. If the
 * arming observation is itself missed — a job short enough to start and
 * finish between two polls — the grace period arms it anyway.
 *
 * Completion then reads the result rather than guessing at it: a sync reports
 * `last_sync_status`, a rebuild the chunk count it settled on.
 *
 * There is a hard ceiling. A backend restart mid-job must not leave the view
 * polling forever.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Panel,
  Spinner,
  TextInput,
  Tooltip,
  cn,
  useToast
} from "@/components/ui";
import { Alert, Check, Corpus as CorpusIcon, Folder, Refresh, Search } from "@/components/icons";
import {
  getRagDocsFolder,
  getRagDocuments,
  getRagStatus,
  startRagReindex,
  startRagSync
} from "@/lib/api";
import type { Citation } from "@/lib/citations";
import { formatAbsolute, formatRelativeTime } from "@/lib/format";
import type { RagDocsFolder, RagDocument, RagStatus } from "@/types/api";

const POLL_INTERVAL_MS = 3_000;
const IDLE_REFRESH_MS = 60_000;
/** Ceiling on inferred-running state. A full corpus rebuild runs into minutes. */
const JOB_CEILING_MS = 20 * 60_000;
/**
 * How long to wait for `sync_in_progress` to go true before arming the job
 * regardless. Covers the gap between the POST returning and the background
 * task taking the guard, and the case where a short job starts and finishes
 * entirely between two polls.
 */
const ARMING_GRACE_MS = 15_000;

type RunningJob = {
  kind: "sync" | "reindex";
  startedAt: number;
  /**
   * `last_sync` as it was when the job was triggered. A sync that ends with
   * this unchanged never reached its status write, so its outcome cannot be
   * read from `last_sync_status`.
   */
  baselineLastSync: string | null;
  /**
   * True once `sync_in_progress` has been observed true, or once the arming
   * grace has elapsed. Only an armed job may be completed by a false flag —
   * see the note at the top of the file.
   */
  armed: boolean;
};

function docTitle(doc: RagDocument): string {
  const title = typeof doc.title === "string" ? doc.title.trim() : "";
  if (title) {
    return title;
  }
  const source = typeof doc.source === "string" ? doc.source.trim() : "";
  return source || "Untitled document";
}

function docType(doc: RagDocument): string {
  return typeof doc.doc_type === "string" && doc.doc_type.trim() ? doc.doc_type : "Document";
}

function docChunks(doc: RagDocument): number {
  return typeof doc.chunks === "number" && Number.isFinite(doc.chunks) ? doc.chunks : 0;
}

/** Stable identity for a row. Metadata is user data, so nothing is guaranteed. */
function docKey(doc: RagDocument, index: number): string {
  const source = typeof doc.source === "string" ? doc.source : "";
  const title = typeof doc.title === "string" ? doc.title : "";
  return `${source}|${title}|${index}`;
}

type CorpusViewProps = {
  /**
   * Set when the user clicked a verified citation in the reply margin. Seeds
   * the document filter so they land on the authority they clicked, not on an
   * unfiltered list they have to search again.
   */
  focusCitation?: Citation | null;
};

export default function CorpusView({ focusCitation }: CorpusViewProps = {}) {
  const toast = useToast();

  const [status, setStatus] = useState<RagStatus | null>(null);
  const [documents, setDocuments] = useState<RagDocument[] | null>(null);
  const [docsFolder, setDocsFolder] = useState<RagDocsFolder | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState(focusCitation?.raw ?? "");
  const [job, setJob] = useState<RunningJob | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [revealedPath, setRevealedPath] = useState<string | null>(null);

  // Read inside the interval callback, which must not be re-created on every
  // status change or the timer restarts and never fires at its own cadence.
  // Written in an effect, not during render: a render can be thrown away or
  // run twice, and mutating a ref there is a side effect in a phase React is
  // allowed to repeat.
  const jobRef = useRef<RunningJob | null>(null);
  useEffect(() => {
    jobRef.current = job;
  }, [job]);

  // The view stays mounted while the user clicks a second citation, so the
  // initial useState seed is not enough. Keyed on the id, not the object, so a
  // re-render with the same citation does not overwrite what the user typed.
  const seededCitationId = useRef<string | null>(focusCitation?.id ?? null);
  useEffect(() => {
    if (focusCitation && focusCitation.id !== seededCitationId.current) {
      seededCitationId.current = focusCitation.id;
      setQuery(focusCitation.raw);
    }
  }, [focusCitation]);

  const refresh = useCallback(async (withDocuments: boolean) => {
    try {
      const next = await getRagStatus();
      setStatus(next);
      setLoadError(null);

      if (withDocuments) {
        // A failed document list must not discard a good status read, so it
        // is awaited separately.
        try {
          setDocuments(await getRagDocuments());
        } catch {
          setDocuments([]);
        }
      }
      return next;
    } catch {
      setLoadError("The corpus status could not be read. The backend may still be starting.");
      return null;
    }
  }, []);

  // First load. Guarded: under StrictMode this effect runs twice, and on a
  // quick navigation away the response can arrive after unmount, so the
  // result is dropped rather than written into a dead component.
  useEffect(() => {
    let cancelled = false;
    void refresh(true);
    void (async () => {
      try {
        const folder = await getRagDocsFolder();
        if (!cancelled) {
          setDocsFolder(folder);
        }
      } catch {
        /* the folder button falls back to a disabled state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Polling. One interval, whose cadence depends on whether a job is inferred
  // to be running; it stops entirely when nothing is.
  useEffect(() => {
    const interval = window.setInterval(
      () => {
        void (async () => {
          const running = jobRef.current;
          const next = await refresh(true);
          if (!running || !next) {
            return;
          }

          const elapsed = Date.now() - running.startedAt;
          if (elapsed > JOB_CEILING_MS) {
            setJob(null);
            // `info`, not `error`: the job may well have succeeded and only the
            // completion signal was missed. Vermilion is reserved for a real
            // failure, and this is not one we can assert.
            toast.show({
              tone: "info",
              title:
                running.kind === "sync"
                  ? "The sync is taking longer than expected"
                  : "The rebuild is taking longer than expected",
              body: "It may still be running. Check the logs folder in Settings."
            });
            return;
          }

          // Arm on the first observation of a running job. Until then a
          // false flag means "has not taken the guard yet", not "finished".
          if (!running.armed) {
            if (next.sync_in_progress) {
              setJob({ ...running, armed: true });
              return;
            }
            if (elapsed < ARMING_GRACE_MS) {
              return;
            }
            // Grace elapsed without ever seeing the flag. The job was short
            // enough to finish between polls, so arm and fall through to the
            // completion check below rather than waiting for a second pass.
            setJob({ ...running, armed: true });
          }

          if (next.sync_in_progress) {
            return;
          }

          setJob(null);

          if (running.kind === "sync") {
            // `last_sync` and `last_sync_status` are written in the same call
            // (`rag_scheduler.rs`, phase 3), so an unchanged timestamp after
            // the flag has dropped means the run died before it got there —
            // a panic or a backend restart. `last_sync_status` would still
            // describe the *previous* run, and reporting that as this run's
            // result is how a crash gets announced as a success.
            if (next.last_sync === running.baselineLastSync) {
              toast.show({
                tone: "error",
                title: "The sync stopped before it finished",
                body: "Check the logs folder in Settings, then sync again."
              });
              return;
            }
            const failed = next.last_sync_status === "failed";
            const partial = next.last_sync_status === "partial";
            toast.show({
              tone: failed ? "error" : partial ? "info" : "success",
              title: failed
                ? "The sync did not finish"
                : partial
                  ? "The sync finished with some sources unread"
                  : "The corpus is up to date",
              body: failed
                ? "Check your connection, then sync again."
                : `${next.chunks_total} passages indexed.`
            });
            return;
          }

          // A rebuild leaves `last_sync` alone, so the chunk count is the only
          // thing that reports on it. Zero means the collection was cleared
          // and nothing re-embedded — a failure, not a finished rebuild.
          if (next.chunks_total === 0) {
            toast.show({
              tone: "error",
              title: "The rebuild left the index empty",
              body: "Sync the corpus, then rebuild again."
            });
            return;
          }
          toast.show({
            tone: "success",
            title: "The index is rebuilt",
            body: `${next.chunks_total} passages indexed.`
          });
        })();
      },
      job ? POLL_INTERVAL_MS : IDLE_REFRESH_MS
    );
    return () => window.clearInterval(interval);
    // `job` is in the deps only as a boolean cadence switch — the identity
    // churn from each poll's setJob is absorbed by jobRef.
  }, [job !== null, refresh, toast]);

  const onSync = async () => {
    setTriggering(true);
    try {
      await startRagSync();
      setJob({
        kind: "sync",
        startedAt: Date.now(),
        baselineLastSync: status?.last_sync ?? null,
        armed: false
      });
    } catch (error) {
      toast.show({
        tone: "error",
        title: "The sync could not start",
        body: error instanceof Error ? error.message : "The backend did not accept the request."
      });
    } finally {
      setTriggering(false);
    }
  };

  const onRebuild = async () => {
    setConfirmRebuild(false);
    setTriggering(true);
    try {
      await startRagReindex();
      setJob({
        kind: "reindex",
        startedAt: Date.now(),
        baselineLastSync: status?.last_sync ?? null,
        armed: false
      });
    } catch (error) {
      toast.show({
        tone: "error",
        title: "The rebuild could not start",
        body: error instanceof Error ? error.message : "The backend did not accept the request."
      });
    } finally {
      setTriggering(false);
    }
  };

  const onOpenFolder = async () => {
    const path = docsFolder?.path;
    if (!path) {
      return;
    }
    const open = window.localAgent?.openPathInBase;
    if (!open) {
      // No host, or a v1 bridge without the v2 addition: show the path so the
      // user can paste it into Explorer themselves.
      setRevealedPath(path);
      return;
    }
    try {
      const result = await open(path);
      if (!result?.ok) {
        setRevealedPath(path);
      }
    } catch {
      setRevealedPath(path);
    }
  };

  const filtered = useMemo(() => {
    if (!documents) {
      return null;
    }
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return documents;
    }
    return documents.filter((doc) => {
      const haystack = [docTitle(doc), docType(doc), doc.date, doc.source]
        .filter((v): v is string => typeof v === "string")
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [documents, query]);

  // The one hint the API doc calls for by name: a corpus that has never synced
  // and has no embedding model needs internet once, and nothing else works
  // until that happens.
  const needsFirstSync =
    status?.embedding_model_available === false && status?.last_sync_status === "never";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="border-b border-rule px-6 py-4">
        <h1 className="text-lg font-semibold text-ink">Corpus</h1>
        <p className="mt-1 text-xs text-ink-muted">
          The circulars, notifications and case law this machine can cite from.
        </p>
      </header>

      <div className="flex flex-col gap-6 p-6">
        {loadError && (
          <Panel className="border-vermilion bg-vermilion-wash p-4">
            <p className="flex items-start gap-2 text-sm text-ink" role="alert">
              <Alert className="mt-px h-4 w-4 shrink-0 text-vermilion" />
              {loadError}
            </p>
          </Panel>
        )}

        {needsFirstSync && (
          <Panel className="border-amber bg-amber-wash p-4">
            <p className="flex items-start gap-2 text-sm text-ink">
              <Alert className="mt-px h-4 w-4 shrink-0 text-amber" />
              Run sync once with internet to download the embedding model.
            </p>
          </Panel>
        )}

        {/* Status */}
        <Panel className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rule px-4 py-3">
            <h2 className="text-sm font-medium text-ink">Index</h2>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void onSync()}
                disabled={triggering || job !== null}
              >
                {job?.kind === "sync" ? (
                  <>
                    <Spinner size="sm" />
                    Syncing
                  </>
                ) : (
                  <>
                    <Refresh className="h-4 w-4" />
                    Sync now
                  </>
                )}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setConfirmRebuild(true)}
                disabled={triggering || job !== null}
              >
                {job?.kind === "reindex" ? (
                  <>
                    <Spinner size="sm" />
                    Rebuilding
                  </>
                ) : (
                  "Rebuild index"
                )}
              </Button>
            </div>
          </div>

          {/*
            The grid itself is not a live region. It polls, and "Last sync"
            is a relative time that changes on its own, so announcing the
            whole thing meant re-reading all five figures on every poll.
            A sync finishing is already announced: the completion toast is a
            role="status" live region, which is the right granularity.
          */}
          {/* `divide-*`, not the `gap-px` + `bg-rule` paint-through
              trick. There are five Stats: at 2 and 3 columns the last row
              is short, and with paint-through the vacant cell had no child
              to cover it, so a solid --rule rectangle showed through. It
              only looked right at the lg 5-column width. Dividers degrade
              correctly at every count. */}
          <dl className="grid grid-cols-2 divide-x divide-y divide-rule border-b border-rule sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Last sync" value={formatRelativeTime(status?.last_sync)}>
              {status?.last_sync ? formatAbsolute(status.last_sync) : undefined}
            </Stat>
            <Stat label="Next sync" value={formatRelativeTime(status?.next_scheduled_sync)}>
              {status?.next_scheduled_sync ? formatAbsolute(status.next_scheduled_sync) : undefined}
            </Stat>
            <Stat
              label="Passages"
              value={status ? status.chunks_total.toLocaleString("en-IN") : "—"}
            />
            <Stat
              label="Superseded"
              value={status ? status.superseded_docs.toLocaleString("en-IN") : "—"}
              tone={status && status.superseded_docs > 0 ? "amber" : undefined}
            />
            <Stat
              label="Embedding model"
              value={
                status === null
                  ? "—"
                  : status.embedding_model_available
                    ? "Ready"
                    : "Not downloaded"
              }
              tone={
                status === null
                  ? undefined
                  : status.embedding_model_available
                    ? "viridian"
                    : "amber"
              }
            />
          </dl>

          {status?.last_sync_status === "failed" && (
            <p className="border-t border-rule px-4 py-3 text-xs text-vermilion">
              The last sync did not finish. Check your connection, then sync again.
            </p>
          )}
          {status?.last_sync_status === "partial" && (
            <p className="border-t border-rule px-4 py-3 text-xs text-amber">
              The last sync finished, but some sources could not be read.
            </p>
          )}
        </Panel>

        {/* Documents */}
        <Panel className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-3">
            <h2 className="text-sm font-medium text-ink">
              Documents
              {filtered && documents && (
                <span className="ml-2 text-xs font-normal text-ink-faint">
                  {filtered.length === documents.length
                    ? `${documents.length} indexed`
                    : `${filtered.length} of ${documents.length}`}
                </span>
              )}
            </h2>
            <div className="flex items-center gap-2">
              <TextInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by title, type or date"
                aria-label="Filter documents"
                icon={<Search className="h-4 w-4" />}
                // Arbitrary: the replaced spacing scale has no step for a
                // filter input wide enough to read a document title in.
                className="w-[14rem]"
              />
              {/* A disabled button swallows pointer events, so Radix's trigger
                  never fires and the tooltip would be dead exactly when it has
                  something to explain. The tooltip is therefore only attached
                  while the control is live; the disabled case carries its
                  reason in the title attribute instead. */}
              {docsFolder?.path ? (
                <Tooltip content="Drop circulars here; the next sync indexes them">
                  <Button variant="secondary" size="sm" onClick={() => void onOpenFolder()}>
                    <Folder className="h-4 w-4" />
                    Open documents folder
                  </Button>
                </Tooltip>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled
                  title="The documents folder is not available yet."
                >
                  <Folder className="h-4 w-4" />
                  Open documents folder
                </Button>
              )}
            </div>
          </div>

          {revealedPath && (
            <div className="border-b border-rule bg-sunken px-4 py-3">
              <p className="text-xs text-ink-muted">
                Open this folder to add documents by hand:
              </p>
              {/* break-all so a long AppData path wraps instead of overflowing
                  the panel at 360px. */}
              <p className="mt-1 break-all font-mono text-xs text-ink">{revealedPath}</p>
            </div>
          )}

          {documents === null ? (
            <p className="flex items-center gap-2 px-4 py-6 text-sm text-ink-faint">
              <Spinner size="sm" />
              Reading the index
            </p>
          ) : documents.length === 0 ? (
            <EmptyState
              icon={<CorpusIcon className="h-6 w-6" />}
              title="Nothing indexed yet"
              description="Run a sync to pull circulars and notifications, or drop PDFs into the documents folder."
              className="py-12"
            />
          ) : filtered && filtered.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-muted">
              No document matches {`"${query.trim()}"`}. Clear the filter to see all{" "}
              {documents.length}.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-rule text-xs text-ink-muted">
                    <th scope="col" className="px-4 py-2 font-medium">
                      Title
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Type
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Date
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Passages
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(filtered ?? []).map((doc, index) => (
                    <tr
                      key={docKey(doc, index)}
                      className="border-b border-rule last:border-b-0"
                    >
                      <td className="px-4 py-2 text-ink">
                        <span className="block max-w-measure">{docTitle(doc)}</span>
                      </td>
                      <td className="px-4 py-2 text-ink-muted">{docType(doc)}</td>
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-ink-muted">
                        {typeof doc.date === "string" && doc.date ? doc.date : "—"}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-ink-muted">
                        {docChunks(doc).toLocaleString("en-IN")}
                      </td>
                      <td className="px-4 py-2">
                        {doc.superseded === true ? (
                          <Badge tone="amber">Superseded</Badge>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-ink-faint">
                            <Check className="h-3 w-3 text-viridian" />
                            In force
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Dialog
        open={confirmRebuild}
        onOpenChange={setConfirmRebuild}
        title="Rebuild the whole index?"
        description="Every indexed passage is deleted and re-read from the documents on this machine. Drafting cannot cite anything until it finishes, which takes minutes on a large corpus."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRebuild(false)}>
              Keep the current index
            </Button>
            <Button variant="danger" onClick={() => void onRebuild()}>
              Rebuild index
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          Your documents are not deleted. Only the index built from them is.
        </p>
      </Dialog>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  children
}: {
  label: string;
  value: string;
  tone?: "amber" | "viridian";
  /** An absolute timestamp shown under a relative one. */
  children?: string | undefined;
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd
        className={cn(
          "mt-1 text-sm font-medium",
          tone === "amber" ? "text-amber" : tone === "viridian" ? "text-viridian" : "text-ink"
        )}
      >
        {value}
      </dd>
      {children && <p className="mt-px font-mono text-xs text-ink-faint">{children}</p>}
    </div>
  );
}
