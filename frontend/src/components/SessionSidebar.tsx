import { Button, Text } from "@fluentui/react-components";
import { Add24Regular, History24Regular } from "@fluentui/react-icons";
import type { SessionSummary } from "../types/api";
import { formatSessionTime } from "../lib/session";

type SessionSidebarProps = {
  sessions: SessionSummary[];
  activeSessionId: string;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
};

export function SessionSidebar({
  sessions,
  activeSessionId,
  onNewSession,
  onSelectSession
}: SessionSidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebarHeader">
        <div>
          <Text weight="semibold" size={400}>
            Sessions
          </Text>
          <Text size={200} className="mutedText">
            Local history
          </Text>
        </div>
        <Button appearance="subtle" icon={<Add24Regular />} aria-label="New session" onClick={onNewSession} />
      </div>

      <div className="sessionList">
        {sessions.length === 0 ? (
          <div className="emptyState">
            <History24Regular />
            <Text size={200}>No saved sessions yet.</Text>
          </div>
        ) : (
          sessions.map((session) => (
            <button
              className={`sessionItem ${session.session_id === activeSessionId ? "active" : ""}`}
              key={session.session_id}
              onClick={() => onSelectSession(session.session_id)}
              type="button"
            >
              <span className="sessionId">{session.session_id}</span>
              <span className="sessionMeta">{formatSessionTime(session.updated_at || session.created_at)}</span>
              <span className="sessionMeta">{session.turn_count} turn{session.turn_count === 1 ? "" : "s"}</span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
