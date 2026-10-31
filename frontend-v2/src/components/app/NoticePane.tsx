/**
 * The left pane: the notice, and everything that shapes the reply.
 *
 * Reading order matches the work: what the notice says, what the reply should
 * argue, which model answers it, then the one button that does the work.
 */

import { useCallback } from "react";

import {
  Button,
  Field,
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  Slider,
  Spinner,
  Switch,
  TextArea,
  cn
} from "@/components/ui";
import { Alert, X } from "@/components/icons";
import { DropZone } from "@/components/app/DropZone";
import type { DraftError, Notice } from "@/hooks/useDraft";
import type { ModelInfo } from "@/types/api";

export type NoticePaneProps = {
  notice: Notice | null;
  isUploading: boolean;
  isDrafting: boolean;
  canDraft: boolean;
  elapsedSeconds: number;
  error: DraftError | null;
  instruction: string;
  model: string | null;
  temperature: number;
  saveOutput: boolean;
  models: readonly ModelInfo[];
  /** False when `/health` reports the model server unreachable. */
  modelServerReady: boolean;
  onFile: (file: File) => void;
  onClearNotice: () => void;
  onInstructionChange: (value: string) => void;
  onModelChange: (value: string | null) => void;
  onTemperatureChange: (value: number) => void;
  onSaveOutputChange: (value: boolean) => void;
  onDraft: () => void;
  onCancel: () => void;
  onDismissError: () => void;
  className?: string;
};

/** `1,234 characters` — the user's unit, not `char_count`. */
function formatCharCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "character" : "characters"}`;
}

/** `2:05` past a minute, `45s` below it. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * Sentinel for "let the backend choose". Radix Select treats `""` as the
 * clear-selection value and refuses it on an item, so auto-select needs a real
 * value here; it is mapped back to the contract's `null` on change.
 */
const AUTO_MODEL = "__auto__";

export function NoticePane({
  notice,
  isUploading,
  isDrafting,
  canDraft,
  elapsedSeconds,
  error,
  instruction,
  model,
  temperature,
  saveOutput,
  models,
  modelServerReady,
  onFile,
  onClearNotice,
  onInstructionChange,
  onModelChange,
  onTemperatureChange,
  onSaveOutputChange,
  onDraft,
  onCancel,
  onDismissError,
  className
}: NoticePaneProps) {
  const handleModelChange = useCallback(
    (value: string) => {
      onModelChange(value === AUTO_MODEL ? null : value);
    },
    [onModelChange]
  );

  return (
    <section
      className={cn("flex min-h-0 flex-col bg-surface", className)}
      aria-label="Notice"
    >
      <header className="flex items-center gap-3 border-b border-rule px-4 py-3">
        <h2 className="text-base font-medium text-ink">Notice</h2>
        {notice ? (
          <span className="min-w-0 truncate font-mono text-xs text-ink-faint" title={notice.filename}>
            {notice.filename}
          </span>
        ) : null}
        {notice ? (
          <button
            type="button"
            onClick={onClearNotice}
            aria-label={`Remove ${notice.filename}`}
            className="ml-auto rounded-control p-1 text-ink-faint transition-colors duration-120 ease-ledger hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-seal focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <X aria-hidden="true" />
          </button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        <DropZone onFile={onFile} isUploading={isUploading} compact={notice !== null} />

        {error ? (
          <div
            // Vermilion is reserved for errors, and this is one.
            className="flex items-start gap-2 rounded-panel border border-vermilion bg-vermilion-wash px-3 py-3"
            role="alert"
          >
            <Alert aria-hidden="true" className="mt-px shrink-0 text-vermilion" />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium text-ink">{error.message}</p>
              {error.action ? <p className="mt-1 text-ink-muted">{error.action}</p> : null}
            </div>
            <button
              type="button"
              onClick={onDismissError}
              aria-label="Dismiss this message"
              className="rounded-control p-1 text-ink-muted transition-colors duration-120 ease-ledger hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-seal focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {notice ? (
          <div className="flex min-h-0 flex-col gap-2">
            <p className="text-xs text-ink-faint">{formatCharCount(notice.charCount)}</p>
            {/* The extracted text is evidence, not prose: sunken well, mono,
                scrollable, and selectable so a line can be quoted. */}
            <div
              className="max-h-[32vh] min-h-24 overflow-y-auto rounded-panel border border-rule bg-sunken px-3 py-3"
              tabIndex={0}
              role="group"
              aria-label="Extracted notice text"
            >
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-normal text-ink-muted">
                {notice.text}
              </pre>
            </div>
          </div>
        ) : null}

        <Field
          label="What should the reply argue?"
          htmlFor="draft-instruction"
          hint="Leave this blank to answer the notice on its own terms."
        >
          <TextArea
            id="draft-instruction"
            value={instruction}
            onChange={(event) => onInstructionChange(event.target.value)}
            rows={4}
            placeholder="Contest the reopening — no fresh tangible material, and the approval is mechanical."
          />
        </Field>

        <Field label="Model" htmlFor="draft-model">
          <SelectRoot value={model ?? AUTO_MODEL} onValueChange={handleModelChange}>
            <SelectTrigger id="draft-model" aria-label="Model">
              <SelectValue placeholder="Choose automatically" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO_MODEL}>Choose automatically</SelectItem>
              {/* Value is the absolute path, label is the name. The backend
                  resolves a `model` override as a path; given a bare stem it
                  falls through to its own primary and drafts with a different
                  model, returning 200, so the user's explicit choice would be
                  discarded silently. */}
              {models.map((info) => (
                <SelectItem key={info.path || info.name} value={info.path || info.name}>
                  {info.name}
                </SelectItem>
              ))}
            </SelectContent>
          </SelectRoot>
        </Field>

        <Field
          label="Temperature"
          htmlFor="draft-temperature"
          hint="Lower stays closer to the statute. Change the starting value in Settings."
        >
          <div className="flex items-center gap-3">
            {/* Radix slider is multi-thumb by design, so a single setting is
                a one-element array in and a one-element array out. */}
            <Slider
              id="draft-temperature"
              min={0}
              max={1}
              step={0.05}
              value={[temperature]}
              onValueChange={(next: number[]) => {
                const first = next[0];
                if (first !== undefined) {
                  onTemperatureChange(first);
                }
              }}
              aria-label="Temperature"
            />
            <span className="w-8 shrink-0 text-right font-mono text-xs text-ink-muted">
              {temperature.toFixed(2)}
            </span>
          </div>
        </Field>

        <Switch
          checked={saveOutput}
          onCheckedChange={onSaveOutputChange}
          label="Save as .docx"
          description="Writes a Word file alongside the draft."
        />
      </div>

      <footer className="border-t border-rule px-4 py-3">
        {!modelServerReady ? (
          <p className="mb-2 text-sm text-ink-muted">
            The model server isn&rsquo;t running. Start it, then draft again.
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            onClick={onDraft}
            disabled={!canDraft || isDrafting}
            className="min-w-[8rem]"
          >
            {isDrafting ? <Spinner aria-hidden="true" /> : null}
            {isDrafting ? "Drafting" : "Draft reply"}
          </Button>

          {isDrafting ? (
            <Button variant="ghost" onClick={onCancel}>
              Stop drafting
            </Button>
          ) : null}

          {/*
            The only honest progress signal: `/generate` is one blocking
            response with no completion fraction.

            The announcement and the counter are deliberately separate. A
            per-second value inside a live region queues an utterance every
            second -- "polite" governs interruption, not frequency, so a
            screen reader spends the whole draft reading the clock and the
            user can hear nothing else. So the live region announces once, on
            entering `drafting`, and the ticking figure sits beside it with
            aria-live="off".
          */}
          <p className="sr-only" role="status" aria-live="polite">
            {isDrafting ? "Drafting. This can take minutes." : ""}
          </p>
          {/* Not mono: the type scale reserves it for refs, IDs and paths.
              This is a sentence. */}
          <p className="text-xs text-ink-faint" aria-live="off">
            {isDrafting
              ? `Drafting, ${formatElapsed(elapsedSeconds)} elapsed. This can take minutes.`
              : ""}
          </p>
        </div>
      </footer>
    </section>
  );
}
