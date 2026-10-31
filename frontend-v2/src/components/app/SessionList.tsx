/**
 * The session list in the left rail.
 *
 * Sessions live on the host filesystem, not the backend, so this reads through
 * the bridge rather than over HTTP. In a plain-browser dev run there is no
 * bridge at all — that is a supported mode, so the absence renders as a quiet
 * note rather than an error state.
 */

import { useCallback, useEffect, useState } from "react";

import { Button, Dialog, IconButton, Spinner, cn } from "@/components/ui";
import { Clock, Trash } from "@/components/icons";
import { installBridge } from "@/lib/bridge";
import { formatAbsolute, formatRelativeTime } from "@/lib/format";
import type { SessionSummary } from "@/types/api";

export interface SessionListProps {
  /** The session currently loaded in the workspace, if any. */
  activeSessionId?: string | null;
  /** Called when the user picks a session to load. */
  onSelect?: (sessionId: string) => void;
  /** Called after a session is deleted, so the workspace can clear it. */
  onDeleted?: (sessionId: string) => void;
  /** Bumped by the parent to force a refetch after a new draft is saved. */
  refreshToken?: number;
  className?: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "no-host" }
  | { kind: "error"; message: string }
  | { kind: "ready"; sessions: SessionSummary[] };

/** Newest first. The host already sorts, but a corrupt mtime must not reorder. */
function byNewest(a: SessionSummary, b: SessionSummary): number {
  // `left` is b and `right` is a, because `left - right` is the descending
  // comparison. The NaN branches follow from that inversion and are verified
  // by sorting a corrupt row against two good ones: a comparator returns a
  // negative number to place `a` first, so `left` (b) being unreadable must
  // return -1 to keep the good `a` ahead of it. Reading these as if the names
  // matched the arguments inverts them and floats the corrupt row to the top.
  const left = new Date(b.updated_at).getTime();
  const right = new Date(a.updated_at).getTime();
  if (Number.isNaN(left) && Number.isNaN(right)) {
    return 0;
  }
  if (Number.isNaN(left)) {
    return -1;
  }
  if (Number.isNaN(right)) {
    return 1;
  }
  return left - right;
}

export default function SessionList({
  activeSessionId,
  onSelect,
  onDeleted,
  refreshToken = 0,
  className
}: SessionListProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // See SettingsView: the bridge is installed by an effect in main.tsx and
    // this list mounts with the app, so reading window.localAgent directly
    // raced it and rendered the "desktop app only" empty state inside the
    // desktop app. Idempotent, so this is free once installed.
    await installBridge();
    const listSessions = window.localAgent?.listSessions;
    if (!listSessions) {
      setState({ kind: "no-host" });
      return;
    }
    try {
      const sessions = await listSessions();
      setState({
        kind: "ready",
        sessions: Array.isArray(sessions) ? [...sessions].sort(byNewest) : []
      });
    } catch {
      setState({
        kind: "error",
        message: "Saved drafts could not be read. Check the logs folder in Settings."
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const confirmDelete = async () => {
    if (!pendingDelete) {
      return;
    }
    const target = pendingDelete.session_id;
    const deleteSession = window.localAgent?.deleteSession;
    if (!deleteSession) {
      setDeleteError("The desktop host is not available, so nothing was deleted.");
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await deleteSession(target);
      if (!result?.success) {
        setDeleteError(result?.error ?? "That session could not be deleted.");
        return;
      }
      // Drop it locally rather than refetching: the rail should not flash an
      // empty list while the host rescans the directory.
      setState((current) =>
        current.kind === "ready"
          ? {
              kind: "ready",
              sessions: current.sessions.filter((s) => s.session_id !== target)
            }
          : current
      );
      setPendingDelete(null);
      onDeleted?.(target);
    } catch {
      setDeleteError("That session could not be deleted.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <h2 className="px-4 pb-2 text-xs font-medium text-ink-muted">Sessions</h2>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        // A delete or a new draft changes this list without the user looking
        // at it; the polite region announces the new count.
        aria-live="polite"
      >
        {state.kind === "loading" && (
          <p className="flex items-center gap-2 px-2 py-2 text-xs text-ink-faint">
            <Spinner size="sm" />
            Reading saved drafts
          </p>
        )}

        {state.kind === "no-host" && (
          <p className="px-2 py-2 text-xs text-ink-faint">
            Saved drafts appear here in the desktop app.
          </p>
        )}

        {state.kind === "error" && (
          <div className="px-2 py-2">
            <p className="text-xs text-vermilion">{state.message}</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => {
                setState({ kind: "loading" });
                void load();
              }}
            >
              Try again
            </Button>
          </div>
        )}

        {state.kind === "ready" && state.sessions.length === 0 && (
          <p className="px-2 py-2 text-xs text-ink-faint">
            No saved drafts yet. Your first reply starts one.
          </p>
        )}

        {state.kind === "ready" && state.sessions.length > 0 && (
          <ul className="space-y-px">
            {state.sessions.map((session) => {
              const active = session.session_id === activeSessionId;
              const turns = Number.isFinite(session.turn_count) ? session.turn_count : 0;
              return (
                <li key={session.session_id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onSelect?.(session.session_id)}
                    // aria-current marks the loaded session for a screen
                    // reader the same way the seal wash marks it visually.
                    aria-current={active ? "true" : undefined}
                    title={formatAbsolute(session.updated_at)}
                    className={cn(
                      "w-full rounded-control py-2 pl-2 pr-8 text-left",
                      "outline-none focus-visible:ring-2 focus-visible:ring-seal focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
                      active
                        ? "bg-seal-wash text-ink"
                        : "text-ink-muted hover:bg-sunken hover:text-ink"
                    )}
                  >
                    <span className="block truncate font-mono text-xs">
                      {session.session_id}
                    </span>
                    {/* Each field is its own element. As bare text nodes the
                        time and the turn count shared one anonymous box, so
                        `gap-2` never applied between them and the row read
                        "2 days ago1 turn". */}
                    <span className="mt-1 flex items-center gap-2 text-xs text-ink-faint">
                      <Clock className="h-3 w-3 shrink-0" />
                      <span>{formatRelativeTime(session.updated_at)}</span>
                      <span>{turns === 1 ? "1 turn" : `${turns} turns`}</span>
                    </span>
                  </button>

                  <IconButton
                    aria-label={`Delete session ${session.session_id}`}
                    size="sm"
                    variant="ghost"
                    // Hidden until hover or keyboard focus, so a rail of ten
                    // sessions is not a wall of delete icons. focus-within on
                    // the row keeps it reachable by tab.
                    className={cn(
                      "absolute right-1 top-2 text-ink-faint",
                      "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                      "focus-visible:opacity-100 hover:text-vermilion"
                    )}
                    onClick={() => {
                      setDeleteError(null);
                      setPendingDelete(session);
                    }}
                  >
                    <Trash className="h-3 w-3" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
        title="Delete this session?"
        description="The notice text, the reply and every turn in it are removed from this machine. Saved .docx files are left alone."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setPendingDelete(null);
                setDeleteError(null);
              }}
            >
              Keep it
            </Button>
            <Button variant="danger" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? "Deleting" : "Delete session"}
            </Button>
          </>
        }
      >
        {pendingDelete && (
          <p className="font-mono text-xs text-ink-muted">{pendingDelete.session_id}</p>
        )}
        {deleteError && (
          <p className="mt-3 text-xs text-vermilion" role="alert">
            {deleteError}
          </p>
        )}
      </Dialog>
    </div>
  );
}
