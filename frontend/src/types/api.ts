export type HealthResponse = {
  ollama_running: boolean;
  primary_model: string;
  fallback_model: string;
  status?: string;
  primary_available?: boolean;
  fallback_available?: boolean;
  models?: string[];
  error?: string | null;
};

export type ModelInfo = {
  name: string;
  size: number;
  modified_at?: string;
};

export type ModelsResponse = ModelInfo[] | {
  primary?: string;
  fallback?: string;
  models?: ModelInfo[];
};

export type UploadResponse = {
  text: string;
  filename: string;
  saved_path?: string;
  char_count?: number;
};

export type HistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

export type GenerateRequest = {
  text: string;
  query: string;
  model: string;
  history: HistoryTurn[];
  session_id: string;
  temperature: number;
};

export type GenerateResponse = {
  reply: string;
  model_used: string;
  output_file: string;
  session_id: string;
};

export type UploadErrorCode =
  | "unsupported_type"
  | "too_large"
  | "empty_text"
  | "network"
  | "timeout"
  | "backend"
  | "unknown";

export type UploadError = {
  code: UploadErrorCode;
  message: string;
  detail?: string;
};

export type SessionTurn = {
  timestamp: string;
  model: string;
  notice_text: string;
  query: string;
  reply: string;
  output_file: string;
};

export type SessionSummary = {
  session_id: string;
  created_at: string;
  updated_at: string;
  turn_count: number;
};

export type StoredSession = {
  session_id: string;
  created_at: string;
  updated_at: string;
  turns: SessionTurn[];
};
