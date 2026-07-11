import type {
  GenerateRequest,
  GenerateResponse,
  HealthResponse,
  ModelInfo,
  ModelsResponse,
  UploadError,
  UploadResponse
} from "../types/api";

const DEFAULT_PORT = 8000;
const UPLOAD_TIMEOUT_MS = 30_000;

// The backend port is dynamic: it falls through 8000 → 8003 when the
// preferred port is taken, and the user can change it in Settings. The
// Electron main process tracks the live port (via port.txt + /health) and
// exposes it over IPC; fall back to 8000 when the preload bridge is absent
// (e.g. the renderer opened in a plain browser during development).
let lastKnownPort = DEFAULT_PORT;

async function apiBase(): Promise<string> {
  try {
    const port = await window.localAgent?.getBackendPort?.();
    if (typeof port === "number" && Number.isInteger(port) && port > 0) {
      lastKnownPort = port;
    }
  } catch {
    /* keep last known port */
  }
  return `http://127.0.0.1:${lastKnownPort}`;
}

// Per-install auth token for mutating requests. The backend rejects
// browser-originated POSTs from unknown origins (incl. the packaged app's
// "null" origin) unless they carry this header; the Electron main process
// reads the token from the backend's data dir and hands it over via IPC.
let cachedAuthToken = "";

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const token = await window.localAgent?.getBackendAuth?.();
    if (typeof token === "string" && token) {
      cachedAuthToken = token;
    }
  } catch {
    /* keep cached token */
  }
  return cachedAuthToken ? { "X-ITax-Auth": cachedAuthToken } : {};
}

/**
 * fetch() against the backend with the live port resolved and — for
 * mutating methods — the local auth header attached. `path` must start
 * with "/". Shared by App.tsx and RagStatusPanel for their direct calls.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = await apiBase();
  const method = (init?.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    ...(method === "GET" ? {} : await authHeaders()),
    ...((init?.headers as Record<string, string>) ?? {})
  };
  return fetch(`${base}${path}`, { ...init, headers });
}

function uploadError(error: UploadError): UploadError {
  return error;
}

async function readBackendDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    return typeof body.detail === "string" ? body.detail : undefined;
  } catch {
    return undefined;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function getHealth(): Promise<HealthResponse> {
  const response = await apiFetch("/health");
  if (!response.ok) {
    throw new Error("Health check failed.");
  }
  return response.json() as Promise<HealthResponse>;
}

export async function getModels(): Promise<ModelInfo[]> {
  const response = await apiFetch("/models");
  if (!response.ok) {
    throw new Error("Model list failed.");
  }

  const body = (await response.json()) as ModelsResponse;
  if (Array.isArray(body)) {
    return body;
  }

  return Array.isArray(body.models) ? body.models : [];
}

export function pickDefaultModel(models: ModelInfo[]): string {
  return (
    models.find((model) => model.name === "qwen2.5:14b")?.name ??
    models.find((model) => model.name === "deepseek-r1:14b")?.name ??
    models[0]?.name ??
    ""
  );
}

export async function uploadFile(file: File): Promise<UploadResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  const body = new FormData();
  body.append("file", file);

  try {
    const response = await apiFetch("/upload", {
      method: "POST",
      body,
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await readBackendDetail(response);
      if (response.status === 415) {
        throw uploadError({ code: "unsupported_type", message: "Unsupported file type", detail });
      }
      if (response.status === 413) {
        throw uploadError({ code: "too_large", message: "File too large", detail });
      }

      throw uploadError({
        code: "backend",
        message: detail ?? "Upload failed",
        detail
      });
    }

    const result = (await response.json()) as UploadResponse;
    if (!result.text || result.text.trim() === "") {
      throw uploadError({
        code: "empty_text",
        message: "Could not extract text from file"
      });
    }

    return result;
  } catch (error) {
    if (isAbortError(error)) {
      throw uploadError({ code: "timeout", message: "Upload timed out" });
    }

    if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
      throw error;
    }

    throw uploadError({ code: "network", message: "Backend not reachable" });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function generateReply(payload: GenerateRequest): Promise<GenerateResponse> {
  const response = await apiFetch("/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const detail = await readBackendDetail(response);
    throw new Error(detail ?? "Generation failed.");
  }

  return response.json() as Promise<GenerateResponse>;
}
