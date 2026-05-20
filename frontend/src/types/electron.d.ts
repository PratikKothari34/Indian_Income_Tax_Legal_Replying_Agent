import type { SessionSummary, StoredSession } from "./api";

declare global {
  interface Window {
    localAgent: {
      openOutputFolder: (outputFile: string) => Promise<{ ok: boolean; error?: string }>;
      listSessions: () => Promise<SessionSummary[]>;
      readSession: (sessionId: string) => Promise<StoredSession>;
    };
  }
}

export {};
