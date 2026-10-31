/**
 * The notice drop target.
 *
 * Drag-and-drop plus click-to-browse over a hidden file input, so the whole
 * zone is one button to a keyboard and a pointer alike. The visible element is
 * a real `<button>` rather than a div with handlers — that is what gets it a
 * focus ring, Enter/Space activation and an accessible name for free.
 */

import { useCallback, useRef, useState } from "react";

import { Spinner, cn } from "@/components/ui";
import { Upload } from "@/components/icons";
import { ACCEPT_ATTRIBUTE } from "@/hooks/useDraft";

export type DropZoneProps = {
  onFile: (file: File) => void;
  isUploading: boolean;
  /** Compact form, shown once a notice is already loaded. */
  compact?: boolean;
  className?: string;
};

export function DropZone({ onFile, isUploading, compact = false, className }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  /**
   * dragenter/dragleave fire for every child element crossed, so a naive
   * boolean flickers. Counting entries and exits is the standard fix.
   */
  const dragDepth = useRef(0);

  const openPicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    // Without this the browser navigates to the dropped file instead of
    // handing it over, which in a webview looks like the app crashing.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      // One notice at a time: a reply answers a notice, not a batch.
      const file = event.dataTransfer.files[0];
      if (file) {
        onFile(file);
      }
    },
    [onFile]
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        onFile(file);
      }
      // Reset so picking the same file twice in a row still fires a change.
      event.target.value = "";
    },
    [onFile]
  );

  return (
    <div
      className={cn("relative", className)}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        onChange={handleChange}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      <button
        type="button"
        onClick={openPicker}
        disabled={isUploading}
        aria-label="Choose a notice file, or drop one here"
        className={cn(
          "flex w-full flex-col items-center justify-center gap-2 rounded-panel border border-dashed text-center",
          "transition-colors duration-120 ease-ledger",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-seal focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
          compact ? "px-4 py-3" : "px-4 py-12",
          isDragging
            ? "border-seal bg-seal-wash text-seal"
            : "border-rule bg-sunken text-ink-muted hover:border-seal hover:text-ink",
          isUploading && "cursor-wait opacity-60"
        )}
      >
        {isUploading ? (
          <>
            <Spinner aria-hidden="true" />
            <span className="text-sm">Reading the notice</span>
          </>
        ) : (
          <>
            <Upload aria-hidden="true" />
            <span className="text-sm font-medium text-ink">
              {compact ? "Replace the notice" : "Drop a notice to start."}
            </span>
            {compact ? null : (
              <span className="text-xs text-ink-faint">
                PDF, Word, spreadsheet, text or image, up to 25 MB
              </span>
            )}
          </>
        )}
      </button>
    </div>
  );
}
