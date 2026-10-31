/**
 * The resizable split between the notice and the reply.
 *
 * Kept out of `DraftWorkspace` because none of it is about drafting: it is
 * pointer capture, a clamp, a keyboard contract and a persisted number. The
 * screen gets back a ratio and a set of props to spread on the divider.
 *
 * The width lives in state as a percentage rather than pixels so a window
 * resize does not need to rescale it, and the grid template is the only thing
 * that changes on a drag.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "ledger.draft.split";
const MIN_PERCENT = 28;
const MAX_PERCENT = 68;
const DEFAULT_PERCENT = 44;
/**
 * The pixel floors from the layout contract: `minmax(380px, 1fr)` for the
 * notice and `minmax(480px, 1.2fr)` for the reply. Enforced in the grid
 * alongside the percentage, which on its own cannot express a floor.
 */
const MIN_NOTICE_PX = 380;
const MIN_REPLY_PX = 480;
/** Below this the panes stack — see the layout contract in docs/DESIGN.md. */
export const STACK_BREAKPOINT = 1100;

function clamp(value: number): number {
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, value));
}

/**
 * localStorage is wrapped in try/catch because it throws outright in a webview
 * with site data blocked, and a remembered pane width is never worth a blank
 * screen.
 */
function readStored(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_PERCENT;
    }
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? clamp(parsed) : DEFAULT_PERCENT;
  } catch {
    return DEFAULT_PERCENT;
  }
}

function writeStored(value: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    /* a lost pane width is not worth surfacing to the user */
  }
}

/** True while the viewport is wide enough for a side-by-side split. */
function useIsSplit(): boolean {
  const [isSplit, setIsSplit] = useState(
    () => typeof window === "undefined" || window.innerWidth >= STACK_BREAKPOINT
  );

  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${STACK_BREAKPOINT}px)`);
    const update = (): void => setIsSplit(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isSplit;
}

/** Props for the `role="separator"` divider element. */
export type SeparatorProps = {
  role: "separator";
  tabIndex: 0;
  "aria-orientation": "vertical";
  "aria-label": string;
  "aria-valuenow": number;
  "aria-valuemin": number;
  "aria-valuemax": number;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
};

export type UseSplitPane = {
  /** Attach to the element the percentage is measured against. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** True when side-by-side; false when the panes stack. */
  isSplit: boolean;
  /** Current first-pane width, as a percentage. */
  percent: number;
  /** True mid-drag, for the divider's active styling. */
  isResizing: boolean;
  /** `grid-template-columns` for the split, or undefined when stacked. */
  gridStyle: React.CSSProperties | undefined;
  separatorProps: SeparatorProps;
};

export function useSplitPane(): UseSplitPane {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [percent, setPercent] = useState(readStored);
  const [isResizing, setIsResizing] = useState(false);
  const isSplit = useIsSplit();

  const apply = useCallback((next: number) => {
    const clamped = clamp(next);
    setPercent(clamped);
    return clamped;
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    // Pointer capture keeps the drag alive once the cursor outruns the 1px
    // divider, which it always does.
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizing(true);
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!isResizing) {
        return;
      }
      const bounds = containerRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width === 0) {
        return;
      }
      apply(((event.clientX - bounds.left) / bounds.width) * 100);
    },
    [apply, isResizing]
  );

  const endResize = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!isResizing) {
        return;
      }
      setIsResizing(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      // Persisted on release rather than on every move: a drag is ~60 writes
      // a second otherwise.
      writeStored(percent);
    },
    [isResizing, percent]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      // The divider is a real control, so to a keyboard it behaves like a
      // slider: arrows nudge, Shift coarsens, Home/End hit the limits and
      // Enter restores the default.
      const step = event.shiftKey ? 8 : 2;
      let next: number | null = null;
      if (event.key === "ArrowLeft") {
        next = percent - step;
      } else if (event.key === "ArrowRight") {
        next = percent + step;
      } else if (event.key === "Home") {
        next = MIN_PERCENT;
      } else if (event.key === "End") {
        next = MAX_PERCENT;
      } else if (event.key === "Enter") {
        next = DEFAULT_PERCENT;
      }
      if (next === null) {
        return;
      }
      event.preventDefault();
      writeStored(apply(next));
    },
    [apply, percent]
  );

  const gridStyle = useMemo(
    () =>
      isSplit
        ? {
            // The floors are the contract's (380px notice / 480px reply) and
            // they are not decoration: the reply has to hold a 72ch measure
            // beside the statutory margin, and the notice a readable extract.
            // A percentage alone cannot express them -- at the 1100px split
            // threshold MIN_PERCENT would hand the notice barely 300px -- so
            // the percentage drives the split and minmax stops it short of
            // unusable. `max-content`-free on purpose: 1fr with a floor can
            // still shrink the pair below the container, which is what the
            // stacked layout under 1100px is for.
            gridTemplateColumns: `minmax(${MIN_NOTICE_PX}px, ${percent}%) 1px minmax(${MIN_REPLY_PX}px, 1fr)`
          }
        : undefined,
    [isSplit, percent]
  );

  const separatorProps = useMemo<SeparatorProps>(
    () => ({
      role: "separator",
      tabIndex: 0,
      "aria-orientation": "vertical",
      "aria-label": "Resize the notice and reply panes",
      "aria-valuenow": Math.round(percent),
      "aria-valuemin": MIN_PERCENT,
      "aria-valuemax": MAX_PERCENT,
      onPointerDown,
      onPointerMove,
      onPointerUp: endResize,
      onPointerCancel: endResize,
      onKeyDown
    }),
    [endResize, onKeyDown, onPointerDown, onPointerMove, percent]
  );

  return { containerRef, isSplit, percent, isResizing, gridStyle, separatorProps };
}
