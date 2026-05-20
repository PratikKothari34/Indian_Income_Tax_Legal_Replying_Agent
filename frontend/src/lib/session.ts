import type { HistoryTurn, StoredSession } from "../types/api";

export function sessionToHistory(session: StoredSession): HistoryTurn[] {
  return session.turns.flatMap((turn) => [
    { role: "user" as const, content: turn.query },
    { role: "assistant" as const, content: turn.reply }
  ]);
}

export function latestTurn(session: StoredSession) {
  return session.turns.at(-1);
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

export function formatSessionTime(value: string): string {
  if (!value) {
    return "No timestamp";
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
