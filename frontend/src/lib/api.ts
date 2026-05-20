import type {
  GenerateRequest,
  GenerateResponse,
  HealthResponse,
  ModelInfo,
  ModelsResponse,
  UploadError,
  UploadResponse
} from "../types/api";

const API_BASE = "http://127.0.0.1:8000";
const UPLOAD_TIMEOUT_MS = 30_000;

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
  const response = await fetch(`${API_BASE}/health`);
  if (!response.ok) {
    throw new Error("Health check failed.");
  }
  return response.json() as Promise<HealthResponse>;
}

export async function getModels(): Promise<ModelInfo[]> {
  const response = await fetch(`${API_BASE}/models`);
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
    const response = await fetch(`${API_BASE}/upload`, {
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
  const response = await fetch(`${API_BASE}/generate`, {
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
