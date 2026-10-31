/**
 * The window caption, drawn by the app rather than by Windows.
 *
 * The OS frame is a dark grey band with its own corner radius and its own
 * type, and on a light theme it sits above the page like a bar someone else
 * installed. `decorations: false` in `tauri.conf.json` removes it; this
 * component puts back the three things it was actually providing — a drag
 * handle, the window controls, and the window's name.
 *
 * It is 32px, matching the Windows caption height, so nothing about the
 * window's proportions changes. The app name lives in the rail already, so
 * this bar carries the name only in `aria-label`: repeating "Income Tax Legal
 * Reply Agent" two inches above the rail's own heading would be the kind of
 * chrome the rest of the interface avoids.
 *
 * In `npm run dev:web` there is no Tauri runtime and the browser draws its own
 * frame, so the whole bar renders nothing.
 */

import { useCallback, useEffect, useState } from "react";

import { cn } from "@/components/ui";
import {
  WindowClose,
  WindowMaximize,
  WindowMinimize,
  WindowRestore
} from "@/components/icons";
import { isTauri } from "@/lib/bridge";

type WindowHandle = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (handler: () => void) => Promise<() => void>;
  /**
   * How far the window currently spills past the monitor's work area, in CSS
   * pixels. Zero on every side unless maximized.
   */
  overflow: () => Promise<Inset>;
};

type Inset = { top: number; right: number; bottom: number; left: number };

const NO_INSET: Inset = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Loads `@tauri-apps/api/window` once and adapts it.
 *
 * Dynamic rather than a top-level import: the module touches Tauri internals
 * on load, and `dev:web` has none. A failure here leaves the caption buttons
 * absent rather than breaking the app — the window is still draggable by the
 * region, and Alt+F4 still closes it.
 */
function useWindowHandle(): WindowHandle | null {
  const [handle, setHandle] = useState<WindowHandle | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const mod = await import("@tauri-apps/api/window");
        const win = mod.getCurrentWindow();
        if (cancelled) {
          return;
        }
        setHandle({
          minimize: () => win.minimize(),
          toggleMaximize: () => win.toggleMaximize(),
          close: () => win.close(),
          isMaximized: () => win.isMaximized(),
          onResized: (fn) => win.onResized(fn),
          overflow: async () => {
            // Everything from Tauri here is in physical pixels; the work area
            // is the monitor's usable rectangle, excluding the taskbar.
            const monitor = await mod.currentMonitor();
            if (!monitor) {
              return NO_INSET;
            }
            const scale = await win.scaleFactor();
            const pos = await win.outerPosition();
            const size = await win.outerSize();
            const area = monitor.workArea;

            // Clamped at zero per side. A window that merely sits inside the
            // work area is not overflowing: a restored window above the
            // taskbar reports a 71px "bottom overflow" otherwise, which as
            // padding would cut 71px off the app for no reason.
            const px = (value: number): number =>
              Math.max(0, Math.round(value / scale));

            return {
              top: px(area.position.y - pos.y),
              left: px(area.position.x - pos.x),
              right: px(pos.x + size.width - (area.position.x + area.size.width)),
              bottom: px(
                pos.y + size.height - (area.position.y + area.size.height)
              )
            };
          }
        });
      } catch {
        /* no window API: the bar stays a drag region and nothing more */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return handle;
}

/**
 * Writes the maximized overflow onto `<html>` for `global.css` to pad with.
 *
 * On the element rather than in React state because the padding belongs to
 * the document, not to this component: the caption is one of several things
 * inside the inset area, and a maximized window that clipped only its own
 * title bar would still be clipping the rail and the reply pane.
 */
function applyWindowInset(inset: Inset | null): void {
  const root = document.documentElement;
  if (!inset || (inset.top | inset.right | inset.bottom | inset.left) === 0) {
    root.removeAttribute("data-maximized");
    root.style.removeProperty("--window-inset-top");
    root.style.removeProperty("--window-inset-right");
    root.style.removeProperty("--window-inset-bottom");
    root.style.removeProperty("--window-inset-left");
    return;
  }
  root.setAttribute("data-maximized", "true");
  root.style.setProperty("--window-inset-top", `${inset.top}px`);
  root.style.setProperty("--window-inset-right", `${inset.right}px`);
  root.style.setProperty("--window-inset-bottom", `${inset.bottom}px`);
  root.style.setProperty("--window-inset-left", `${inset.left}px`);
}

/**
 * One caption button.
 *
 * Not `IconButton`: that primitive is a rounded 28px control with a seal focus
 * ring and the interface's hover wash, which is correct everywhere except
 * here. A caption button is a full-height square with no radius and no gap —
 * the shape the pointer expects at the corner of a window, and the shape that
 * lets the close button reach the very last pixel so a flung cursor still
 * lands on it.
 */
function CaptionButton({
  label,
  onClick,
  danger,
  children
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex h-8 w-[46px] shrink-0 items-center justify-center",
        "text-ink-muted transition-colors duration-120 ease-ledger",
        // The ring is inset: an offset ring on a control flush with the window
        // edge is clipped on two sides.
        "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-seal",
        danger
          ? // Close is destructive, and this is one of vermilion's three
            // reserved uses. The glyph is `on-vermilion`, not white: the fill
            // is dark in the light theme and light in the dark one, so white
            // measures 5.79 on the first and 2.81 on the second.
            "hover:bg-vermilion hover:text-on-vermilion"
          : // `rule`, not `sunken`. Sunken against the caption's paper is
            // 1.04:1 in the dark theme -- a hover state nobody can see. Rule
            // gives 1.33:1, which is the magnitude a surface shift wants.
            "hover:bg-rule hover:text-ink"
      )}
    >
      {children}
    </button>
  );
}

export function TitleBar({ title }: { title: string }) {
  const handle = useWindowHandle();
  const [maximized, setMaximized] = useState(false);

  // Tracked rather than assumed, because the window can be maximized by the
  // OS — a double-click on the drag region, Win+Up, or a drag to the top edge
  // — and a restore glyph that disagrees with the window is worse than none.
  useEffect(() => {
    if (!handle) {
      return;
    }
    let cancelled = false;
    let off: (() => void) | undefined;

    const sync = (): void => {
      void (async () => {
        const value = await handle.isMaximized();
        // Measured, never assumed. The spill is the invisible resize border,
        // which scales with DPI: SM_CXFRAME + SM_CXPADDEDBORDER reports 8
        // unscaled on this machine where the window actually overflows by 7,
        // and a second monitor at another scale would differ again.
        const inset = value ? await handle.overflow() : NO_INSET;
        if (cancelled) {
          return;
        }
        setMaximized(value);
        applyWindowInset(value ? inset : null);
      })();
    };

    sync();
    void handle.onResized(sync).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      off = unlisten;
    });

    return () => {
      cancelled = true;
      off?.();
      // The attribute lives on <html>, which outlives this component.
      applyWindowInset(null);
    };
  }, [handle]);

  const onToggleMaximize = useCallback(() => {
    void handle?.toggleMaximize();
  }, [handle]);

  if (!isTauri()) {
    return null;
  }

  return (
    <div
      // `data-tauri-drag-region` is read by the webview on mousedown, so it has
      // to be on the element the pointer actually hits. The buttons are
      // children and are excluded by Tauri's own hit test, but the flex spacer
      // between them carries it too so the whole empty span drags.
      data-tauri-drag-region
      onDoubleClick={onToggleMaximize}
      className="flex h-8 shrink-0 select-none items-center border-b border-rule bg-paper"
      // The caption is not a landmark and not interactive as a whole; it is
      // named so a screen reader user who lands on the buttons knows what
      // window they belong to.
      role="group"
      aria-label={`${title} window controls`}
    >
      {/* Left: deliberately empty. The window's identity is the rail's job;
          this space exists to be grabbed. */}
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />

      {handle ? (
        <div className="flex h-full shrink-0 items-stretch">
          <CaptionButton label="Minimize" onClick={() => void handle.minimize()}>
            <WindowMinimize />
          </CaptionButton>
          <CaptionButton
            label={maximized ? "Restore down" : "Maximize"}
            onClick={onToggleMaximize}
          >
            {maximized ? <WindowRestore /> : <WindowMaximize />}
          </CaptionButton>
          <CaptionButton label="Close" danger onClick={() => void handle.close()}>
            <WindowClose />
          </CaptionButton>
        </div>
      ) : null}
    </div>
  );
}

export default TitleBar;
