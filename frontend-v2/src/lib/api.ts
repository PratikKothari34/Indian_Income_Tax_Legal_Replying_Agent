/**
 * Backend HTTP client.
 *
 * Two things here are easy to get wrong and only fail in the packaged build:
 *
 * 1. **The port is dynamic.** The backend falls through 8000→8003 and writes
 *    the bound port to `port.txt`; the host reads it. Never hardcode 8000
 *    beyond the initial fallback.
 * 2. **Mutating requests need `X-ITax-Auth`.** Dev origins are trusted by the
 *    backend, so a missing header passes in dev and 403s only once packaged.
 *    The header is therefore attached unconditionally to every non-GET.
 */

import type {
  GenerateRequest,
  GenerateResponse,
  HealthResponse,
  ModelsResponse,
  RagDocsFolder,
  RagDocument,
  RagStatus,
  UploadError,
  UploadResponse
} from "@/types/api";

const DEFAULT_PORT = 8000;
const UPLOAD_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 8_000;

let lastKnownPort = DEFAULT_PORT;
let cachedAuthToken = "";

async function apiBase(): Promise<string> {
  try {
    const port = await window.localAgent?.getBackendPort?.();
    if (typeof port === "number" && Number.isInteger(port) && port > 0) {
      lastKnownPort = port;
    }
  } catch {
    /* keep the last known port */
  }
  return `http://127.0.0.1:${lastKnownPort}`;
}

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const token = await window.localAgent?.getBackendAuth?.();
    if (typeof token === "string" && token) {
      cachedAuthToken = token;
    }
  } catch {
    /* keep the cached token */
  }
  return cachedAuthToken ? { "X-ITax-Auth": cachedAuthToken } : {};
}

/** fetch() with the live port resolved and the auth header on mutations. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = await apiBase();
  const method = (init?.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    ...(method === "GET" ? {} : await authHeaders()),
    ...((init?.headers as Record<string, string> | undefined) ?? {})
  };
  return fetch(`${base}${path}`, { ...init, headers });
}

async function readDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    return typeof body.detail === "string" ? body.detail : undefined;
  } catch {
    return undefined;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const id = window.setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => window.clearTimeout(id) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getHealth(): Promise<HealthResponse> {
  const { signal, done } = withTimeout(HEALTH_TIMEOUT_MS);
  try {
    const response = await apiFetch("/health", { signal });
    if (!response.ok) {
      throw new Error("Health check failed.");
    }
    return (await response.json()) as HealthResponse;
  } finally {
    done();
  }
}

export async function getModels(): Promise<ModelsResponse> {
  const response = await apiFetch("/models");
  if (!response.ok) {
    const detail = await readDetail(response);
    throw new Error(detail ?? "Could not list models.");
  }
  return (await response.json()) as ModelsResponse;
}

export async function getRagStatus(): Promise<RagStatus> {
  const response = await apiFetch("/rag/status");
  if (!response.ok) {
    throw new Error("Could not read the corpus status.");
  }
  return (await response.json()) as RagStatus;
}

/** `GET /rag/documents` returns a bare array, unlike `/models`. */
export async function getRagDocuments(): Promise<RagDocument[]> {
  const response = await apiFetch("/rag/documents");
  if (!response.ok) {
    throw new Error("Could not list corpus documents.");
  }
  const body = (await response.json()) as unknown;
  return Array.isArray(body) ? (body as RagDocument[]) : [];
}

export async function getRagDocsFolder(): Promise<RagDocsFolder> {
  const response = await apiFetch("/rag/docs-folder");
  if (!response.ok) {
    throw new Error("Could not find the documents folder.");
  }
  return (await response.json()) as RagDocsFolder;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function uploadError(error: UploadError): UploadError {
  return error;
}

export async function uploadFile(file: File): Promise<UploadResponse> {
  const { signal, done } = withTimeout(UPLOAD_TIMEOUT_MS);
  const body = new FormData();
  body.append("file", file);

  try {
    const response = await apiFetch("/upload", { method: "POST", body, signal });

    if (!response.ok) {
      const detail = await readDetail(response);
      if (response.status === 415) {
        throw uploadError({
          code: "unsupported_type",
          message: "That file type isn't supported",
          detail
        });
      }
      if (response.status === 413) {
        throw uploadError({
          code: "too_large",
          message: "That file is over the 25 MB limit",
          detail
        });
      }
      throw uploadError({ code: "backend", message: detail ?? "Upload failed", detail });
    }

    const result = (await response.json()) as UploadResponse;
    if (!result.text || result.text.trim() === "") {
      throw uploadError({
        code: "empty_text",
        message: "No text could be read from that file"
      });
    }
    return result;
  } catch (error) {
    if (isAbort(error)) {
      throw uploadError({ code: "timeout", message: "The upload timed out" });
    }
    if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
      throw error;
    }
    throw uploadError({ code: "network", message: "The backend isn't reachable" });
  } finally {
    done();
  }
}

/**
 * A `/generate` failure that still knows its HTTP status.
 *
 * Without this the caller is left matching on the prose of the message to
 * decide what went wrong, which misclassifies: a 400 whose detail happens to
 * contain the word "model" ("Model name is too long.") reads as a dead model
 * server, and the user is told to start a server that is already running.
 */
export class GenerateError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GenerateError";
    this.status = status;
  }
}

/**
 * Draft a reply.
 *
 * Not streaming — a single blocking JSON response that can take minutes. There
 * is deliberately no client timeout: aborting a long generation loses work the
 * backend has already done, and the request is loopback-only.
 */
export async function generateReply(
  payload: GenerateRequest,
  signal?: AbortSignal
): Promise<GenerateResponse> {
  const response = await apiFetch("/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    const detail = await readDetail(response);
    if (response.status === 503) {
      throw new GenerateError(
        503,
        detail ?? "The model server isn't reachable. Start it, then try again."
      );
    }
    if (response.status === 413) {
      throw new GenerateError(
        413,
        "The notice text is too long to send. Trim it and try again."
      );
    }
    throw new GenerateError(
      response.status,
      detail ?? "The draft could not be generated."
    );
  }
  return (await response.json()) as GenerateResponse;
}

/**
 * Write the reply already on screen to a `.docx`.
 *
 * Saving does not touch the model. The button used to call `/generate` with
 * `save_output`, which meant a "Save" cost minutes of inference and replaced
 * the text the user was reading with a fresh generation. The reply travels in
 * the body rather than being re-read from the session, so an edited draft
 * saves what the user can actually see.
 */
export async function saveReplyDocx(reply: string): Promise<string> {
  const response = await apiFetch("/save-docx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reply })
  });

  if (!response.ok) {
    const detail = await readDetail(response);
    throw new GenerateError(
      response.status,
      detail ?? "The Word file could not be written."
    );
  }
  const body = (await response.json()) as { output_file: string };
  return body.output_file;
}

export async function startRagSync(): Promise<void> {
  const response = await apiFetch("/rag/sync", { method: "POST" });
  if (!response.ok) {
    const detail = await readDetail(response);
    throw new Error(detail ?? "Could not start the sync.");
  }
}

/** Destructive — wipes the vector store and re-embeds. Confirm before calling. */
export async function startRagReindex(): Promise<void> {
  const response = await apiFetch("/rag/reindex", { method: "POST" });
  if (!response.ok) {
    const detail = await readDetail(response);
    throw new Error(detail ?? "Could not start the rebuild.");
  }
}
