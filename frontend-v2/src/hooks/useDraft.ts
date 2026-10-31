/**
 * The drafting state machine.
 *
 * Owns everything the Draft workspace needs to go from a dropped notice to a
 * reply: upload, instruction, model, temperature, the blocking `/generate`
 * call, and the session history that lets a second draft continue the first.
 *
 * Two contract facts shape this hook:
 *
 * 1. **`/generate` is blocking and can take minutes** (API.md). There is no
 *    SSE to subscribe to, so "progress" is an elapsed timer plus a live region;
 *    the draft-stream animation is a client-side reveal of text already
 *    received. The call is given an `AbortSignal` so the user can walk away
 *    from a draft that is taking too long.
 * 2. **`save_output` defaults to false**, so the switch sets a flag used on
 *    the *next* draft. Saving a draft already on screen does NOT re-request
 *    it: `saveExistingDraft` posts the reply text to `/save-docx`, which
 *    writes the file and nothing else. Re-running the model on a button
 *    labelled "Save" cost minutes and silently replaced the text the user
 *    was reading.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  GenerateError,
  generateReply,
  saveReplyDocx,
  uploadFile
} from "@/lib/api";
import type {
  GenerateResponse,
  HistoryTurn,
  UploadError,
  UploadErrorCode,
  UploadResponse
} from "@/types/api";

export type DraftStatus =
  | "idle"
  | "uploading"
  | "ready"
  | "drafting"
  | "done"
  | "error";

/** Client-side guard. The backend enforces the same 25 MiB cap with a 413. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const ACCEPTED_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".doc",
  ".txt",
  ".xlsx",
  ".xls",
  ".png",
  ".jpg",
  ".jpeg"
] as const;

/** For the hidden file input's `accept`. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(",");

export type Notice = {
  /** The name the backend actually wrote — differs on collision. */
  filename: string;
  savedPath: string;
  charCount: number;
  text: string;
};

export type Draft = {
  reply: string;
  modelUsed: string;
  outputFile: string | null;
  sessionId: string;
};

export type DraftError = {
  message: string;
  /** What the user should do next, when there is a concrete action. */
  action?: string;
  code?: UploadErrorCode | "model_server" | "too_long" | "cancelled" | "backend";
};

export type UseDraft = {
  status: DraftStatus;
  notice: Notice | null;
  draft: Draft | null;
  error: DraftError | null;
  /** Seconds since the current draft started. 0 when not drafting. */
  elapsedSeconds: number;
  /** True while a `/generate` request is in flight. */
  isDrafting: boolean;
  /** True once a notice or an instruction can produce a draft. */
  canDraft: boolean;
  /** Turns accumulated in this session, oldest first. */
  history: HistoryTurn[];
  sessionId: string | null;
  instruction: string;
  model: string | null;
  temperature: number;
  saveOutput: boolean;
  setInstruction: (value: string) => void;
  setModel: (value: string | null) => void;
  setTemperature: (value: number) => void;
  setSaveOutput: (value: boolean) => void;
  acceptFile: (file: File) => Promise<void>;
  clearNotice: () => void;
  draftReply: () => Promise<void>;
  cancelDraft: () => void;
  /** Write the reply on screen to a `.docx`. Does not run the model. */
  saveExistingDraft: () => Promise<void>;
  /** True while `saveExistingDraft` is in flight. */
  isSavingDocx: boolean;
  dismissError: () => void;
  reset: () => void;
};

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Mirrors `validate_model` in `backend-rs/src/routes/generate.rs`: the model
 * override is a path to a GGUF, so an absolute Windows path with a drive
 * letter and backslashes is the normal case, not an attack. The checks that
 * matter are the backend's -- no control characters, no UNC prefix, no `..`
 * component, 512 chars -- and they are reproduced here so a bad value is
 * caught before the request rather than as a 400.
 */
const MODEL_MAX_LEN = 512;

function isValidModel(model: string): boolean {
  const value = model.trim();
  if (!value) {
    return true;
  }
  if (value.length > MODEL_MAX_LEN) {
    return false;
  }
  // Control characters, matching the backend's own rejection set.
  if (/[\u0000\n\r]/.test(value)) {
    return false;
  }
  // A UNC share: two leading separators of either kind.
  if (value.startsWith("\\\\") || value.startsWith("//")) {
    return false;
  }
  // No climbing component, whichever separator the path uses.
  return !value.split(/[/\\]/).includes("..");
}

function isUploadError(value: unknown): value is UploadError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

/**
 * Translate an upload failure into the interface's voice: what happened, then
 * what to do. Never an apology, per the copy contract.
 */
function describeUploadError(error: unknown): DraftError {
  if (isUploadError(error)) {
    switch (error.code) {
      case "unsupported_type":
        return {
          code: error.code,
          message: "That file type isn't supported.",
          action: "Use a PDF, Word file, spreadsheet, text file or image."
        };
      case "too_large":
        return {
          code: error.code,
          message: "That file is over the 25 MB limit.",
          action: "Split the notice or save it at a lower resolution."
        };
      case "empty_text":
        return {
          code: error.code,
          message: "No text could be read from that file.",
          action: "If it is a scan, check the pages are right side up."
        };
      case "timeout":
        return {
          code: error.code,
          message: "Reading that file took too long.",
          action: "Try again, or use a smaller file."
        };
      case "network":
        return {
          code: error.code,
          message: "The backend isn't reachable.",
          action: "Check it is running, then upload again."
        };
      default:
        return { code: "backend", message: error.message, action: error.detail };
    }
  }
  return {
    code: "backend",
    message: "The notice could not be read.",
    action: "Try again."
  };
}

/**
 * Translate a `/generate` failure.
 *
 * Branches on the HTTP status, not the wording. Only a 503 means the model
 * server is down; a 400 is the backend rejecting the request, and telling the
 * user to start a server that is already running sends them the wrong way.
 */
function describeDraftError(error: unknown): DraftError {
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "cancelled", message: "Drafting stopped." };
  }

  if (error instanceof GenerateError) {
    if (error.status === 503) {
      return {
        code: "model_server",
        message: "The model server isn't running.",
        action: "Start it, then draft again."
      };
    }
    if (error.status === 413) {
      return {
        code: "too_long",
        message: "The notice text is too long to send.",
        action: "Trim it, then draft again."
      };
    }
    // 400/422 and anything else: the backend's own sentence is the most
    // specific thing available, so it is shown as given. The action is
    // generic because the cause is not known here -- but every other branch
    // offers one, and the branch that does not is the one that looks broken.
    return {
      code: "backend",
      message: error.message,
      action: "Change what you asked for, then draft again."
    };
  }

  // Not an HTTP failure at all -- a dropped connection, so fetch rejected
  // before any status existed.
  //
  // The rejection's own text is deliberately not the headline. `fetch` says
  // "Failed to fetch" for every network-layer refusal -- the backend down,
  // the port moved, a CORS header missing -- and showing that as the error's
  // main sentence tells the user nothing they can act on while reading as a
  // crash. The written sentence leads; the browser's goes underneath.
  const detail = error instanceof Error ? error.message : "";
  return {
    code: "backend",
    message: "The draft could not be generated. The backend did not respond.",
    action: detail
      ? `Check the backend is running, then draft again. (${detail})`
      : "Check the backend is running, then draft again."
  };
}

export function useDraft(): UseDraft {
  const [status, setStatus] = useState<DraftStatus>("idle");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<DraftError | null>(null);
  const [history, setHistory] = useState<HistoryTurn[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [model, setModel] = useState<string | null>(null);
  // Seeded from the stored defaults below. The literals are the same values
  // the host and the backend default to, and they are what the browser dev
  // run uses, where there is no host to ask.
  const [temperature, setTemperature] = useState(0.2);
  const [saveOutput, setSaveOutput] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Saving an existing draft is a write, not a draft run, so it has its own
  // flag: `status` stays "done" and the reply on screen never flickers.
  const [isSavingDocx, setIsSavingDocx] = useState(false);

  /**
   * True once the user has touched either control. Seeding from the config
   * is async, so without this a preference arriving a moment after mount
   * would overwrite a change the user had already made.
   */
  const draftPrefsTouched = useRef(false);

  /**
   * The stored "save a .docx" preference, so `reset` returns to what the
   * user chose in Settings rather than to a hardcoded false. Starting a new
   * reply should not quietly turn off a setting they switched on.
   */
  const savedSaveOutputDefault = useRef(false);

  // Apply the saved drafting preferences once, at mount. These are the
  // starting values for a session, not a lock: both controls stay editable
  // per draft, which is why they are seeded rather than read on each send.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await window.localAgent?.getConfig?.();
        if (cancelled || !config || draftPrefsTouched.current) {
          return;
        }
        if (Number.isFinite(config.default_temperature)) {
          setTemperature(config.default_temperature);
        }
        savedSaveOutputDefault.current = config.always_save_docx;
        setSaveOutput(config.always_save_docx);
      } catch {
        /* no host, or settings unreadable: the literals above stand */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const abortRef = useRef<AbortController | null>(null);
  /**
   * Guards a state write after unmount, and lets a cancelled request's
   * rejection be ignored without racing the next draft's result.
   */
  const requestIdRef = useRef(0);
  /**
   * The same guard for uploads, counted separately. `uploadFile` takes no
   * AbortSignal and has its own 120s timeout, so two overlapping uploads both
   * run to completion and resolve in whatever order the responses arrive --
   * drop a large notice then a small one and the large one lands last,
   * silently replacing the notice the user is looking at. Sharing
   * `requestIdRef` would be wrong: an upload would then invalidate an
   * in-flight draft, which is a different operation.
   */
  const uploadIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const isDrafting = status === "drafting";

  // The elapsed timer is the only honest progress signal available: the
  // response is a single blocking JSON body, so there is no completion
  // fraction to report. One interval, torn down with the draft.
  useEffect(() => {
    if (!isDrafting) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const id = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [isDrafting]);

  const dismissError = useCallback(() => {
    setError(null);
    setStatus((current) => {
      if (current !== "error") {
        return current;
      }
      if (draft) {
        return "done";
      }
      return notice ? "ready" : "idle";
    });
  }, [draft, notice]);

  const clearNotice = useCallback(() => {
    setNotice(null);
    setError(null);
    setStatus(draft ? "done" : "idle");
  }, [draft]);

  const acceptFile = useCallback(async (file: File) => {
    setError(null);

    // Checked before the request so an oversized file never travels: the
    // backend would 413 it anyway, and a 25 MB upload over loopback still
    // costs the user seconds of waiting for a predictable refusal.
    if (file.size > MAX_UPLOAD_BYTES) {
      const megabytes = (file.size / (1024 * 1024)).toFixed(1);
      setError({
        code: "too_large",
        message: `That file is ${megabytes} MB, over the 25 MB limit.`,
        action: "Split the notice or save it at a lower resolution."
      });
      setStatus((current) => (current === "uploading" ? "idle" : current));
      return;
    }

    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.some((accepted) => accepted === extension)) {
      setError({
        code: "unsupported_type",
        message: "That file type isn't supported.",
        action: "Use a PDF, Word file, spreadsheet, text file or image."
      });
      return;
    }

    setStatus("uploading");
    const uploadId = uploadIdRef.current + 1;
    uploadIdRef.current = uploadId;
    try {
      const result: UploadResponse = await uploadFile(file);
      if (!mountedRef.current || uploadIdRef.current !== uploadId) {
        return;
      }
      setNotice({
        filename: result.filename,
        savedPath: result.saved_path,
        charCount: result.char_count,
        text: result.text
      });
      setStatus("ready");
    } catch (uploadFailure) {
      if (!mountedRef.current || uploadIdRef.current !== uploadId) {
        return;
      }
      setError(describeUploadError(uploadFailure));
      setStatus(notice ? "ready" : "error");
    }
  }, [notice]);

  const canDraft = useMemo(() => {
    if (isDrafting || status === "uploading") {
      return false;
    }
    // The contract requires at least one of text/query non-blank, else 400.
    return (notice?.text.trim() ?? "") !== "" || instruction.trim() !== "";
  }, [instruction, isDrafting, notice, status]);

  /**
   * Run the model and replace the draft on screen.
   *
   * Only `draftReply` calls this. Saving used to as well, with a
   * `reuseTurn` flag that kept the re-run out of the transcript; saving now
   * goes to `/save-docx` and never runs the model, so the flag is gone.
   */
  const runGenerate = useCallback(
    async (options: { save: boolean }) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;

      // Validated client-side because the contract returns 422 for a bad
      // shape, which would otherwise reach the user as a generic failure.
      const safeSession =
        sessionId !== null && SESSION_ID_RE.test(sessionId) ? sessionId : null;
      const safeModel = model !== null && isValidModel(model) ? model : null;

      setError(null);
      setStatus("drafting");

      try {
        const response: GenerateResponse = await generateReply(
          {
            text: notice?.text ?? "",
            query: instruction,
            model: safeModel,
            // The full history as the UI knows it. The turn being drafted
            // is appended below, after the reply lands, so it is correctly
            // absent here.
            history,
            session_id: safeSession,
            temperature,
            save_output: options.save
          },
          controller.signal
        );

        if (!mountedRef.current || requestIdRef.current !== requestId) {
          return;
        }

        setDraft({
          reply: response.reply,
          modelUsed: response.model_used,
          outputFile: response.output_file,
          sessionId: response.session_id
        });
        setSessionId(response.session_id);
        setHistory((current) => [
          ...current,
          { role: "user", content: instruction },
          { role: "assistant", content: response.reply }
        ]);
        setStatus("done");
      } catch (draftFailure) {
        if (!mountedRef.current || requestIdRef.current !== requestId) {
          return;
        }
        const described = describeDraftError(draftFailure);
        setError(described);
        // A cancelled draft is not an error state: the user chose it, and any
        // previous draft is still on screen and still valid.
        if (described.code === "cancelled") {
          setStatus(draft ? "done" : notice ? "ready" : "idle");
        } else {
          setStatus("error");
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [draft, history, instruction, model, notice, sessionId, temperature]
  );

  const draftReply = useCallback(async () => {
    if (!canDraft) {
      return;
    }
    await runGenerate({ save: saveOutput });
  }, [canDraft, runGenerate, saveOutput]);

  /**
   * Write the reply on screen to a `.docx`.
   *
   * This used to call `/generate` with `save: true`, which re-ran the model:
   * minutes of waiting, and the new reply replaced the one the user had been
   * reading, on a button labelled "Save". Saving now hits `/save-docx` and
   * never touches the model, so the only thing that changes is `outputFile`.
   */
  const saveExistingDraft = useCallback(async () => {
    if (!draft || isDrafting || isSavingDocx) {
      return;
    }
    setIsSavingDocx(true);
    try {
      const outputFile = await saveReplyDocx(draft.reply);
      if (!mountedRef.current) {
        return;
      }
      setDraft((current) => (current ? { ...current, outputFile } : current));
    } catch (saveFailure) {
      if (!mountedRef.current) {
        return;
      }
      const message =
        saveFailure instanceof GenerateError
          ? saveFailure.message
          : "The Word file could not be written.";
      setError({
        code: "backend",
        message,
        action: "Check the backend is running, then save again."
      });
    } finally {
      if (mountedRef.current) {
        setIsSavingDocx(false);
      }
    }
  }, [draft, isDrafting, isSavingDocx]);

  const cancelDraft = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Wrapped rather than exposed raw: a user edit has to win over a config
  // read that is still in flight.
  const changeTemperature = useCallback((value: number) => {
    draftPrefsTouched.current = true;
    setTemperature(value);
  }, []);

  const changeSaveOutput = useCallback((value: boolean) => {
    draftPrefsTouched.current = true;
    setSaveOutput(value);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    requestIdRef.current += 1;
    setStatus("idle");
    setNotice(null);
    setDraft(null);
    setError(null);
    setHistory([]);
    setSessionId(null);
    setInstruction("");
    // Back to the stored preference, not to false.
    setSaveOutput(savedSaveOutputDefault.current);
  }, []);

  return {
    status,
    notice,
    draft,
    error,
    elapsedSeconds,
    isDrafting,
    canDraft,
    history,
    sessionId,
    instruction,
    model,
    temperature,
    saveOutput,
    setInstruction,
    setModel,
    setTemperature: changeTemperature,
    setSaveOutput: changeSaveOutput,
    acceptFile,
    clearNotice,
    draftReply,
    cancelDraft,
    saveExistingDraft,
    isSavingDocx,
    dismissError,
    reset
  };
}
