/**
 * Minimal toast, hand-rolled rather than via `@radix-ui/react-toast`.
 *
 * Radix's toast is a swipe-dismissable, hotkey-reachable region built for a
 * web app with many concurrent notifications. This app emits one short
 * confirmation or one error at a time from a desktop window, so the primitive
 * would be more moving parts than behaviour. What matters — a polite live
 * region, a dismiss control, and an auto-dismiss that does not fire on errors
 * — is below.
 *
 * Errors do not auto-dismiss: an error is the one message the user may need to
 * read twice, and a vanishing error is a lost error.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { cn } from "./cn";
import { IconButton } from "./IconButton";
import { Alert, Check, Info, X } from "@/components/icons";

/**
 * Three tones, matching the design system. There is deliberately no
 * "warning": amber marks a deadline or an unverified citation in place, and a
 * transient toast is not where a caution belongs.
 */
export type ToastTone = "info" | "success" | "error";

export interface ToastOptions {
  title: string;
  /** One sentence of what to do next. Errors never apologise. */
  body?: React.ReactNode;
  /** Accepted as a synonym of `body`. */
  description?: React.ReactNode;
  tone?: ToastTone;
  /** Accepted as a synonym of `tone`. */
  variant?: ToastTone;
  /** Milliseconds. Ignored for errors, which stay until dismissed. */
  duration?: number;
}

interface ToastRecord {
  id: number;
  title: string;
  body: React.ReactNode;
  tone: ToastTone;
}

interface ToastApi {
  toast: (options: ToastOptions) => void;
  /** Alias of `toast`, for call sites that read better as `show`. */
  show: (options: ToastOptions) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Imperative handle for emitting a toast. Throws rather than no-oping when
 * the provider is missing: a silently swallowed error toast is worse than a
 * crash in development.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) {
    throw new Error("useToast must be used inside a ToastProvider");
  }
  return api;
}

const DEFAULT_DURATION = 5000;

/**
 * Borders are full strength, not `/30`. At 30% over its own wash the border
 * resolves to about 1.6:1 against the page — short of the 3:1 a meaningful
 * boundary needs, and the thing that tells a toast apart from the page. At
 * full strength the same borders measure 4.9–5.3:1.
 */
const toneStyles: Record<ToastTone, string> = {
  info: "border-rule-strong bg-surface text-ink",
  success: "border-viridian bg-viridian-wash text-ink",
  // Vermilion is reserved for errors — this is one of the three uses.
  error: "border-vermilion bg-vermilion-wash text-ink"
};

const toneIconColour: Record<ToastTone, string> = {
  info: "text-ink-faint",
  success: "text-viridian",
  error: "text-vermilion"
};

function ToastIcon({ tone }: { tone: ToastTone }) {
  const className = cn("h-4 w-4 shrink-0", toneIconColour[tone]);
  if (tone === "success") return <Check className={className} />;
  if (tone === "error") return <Alert className={className} />;
  return <Info className={className} />;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(0);
  // Timers are kept out of state so a re-render never reschedules a dismiss.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    ({
      title,
      body,
      description,
      tone,
      variant,
      duration
    }: ToastOptions) => {
      const id = nextId.current++;
      const resolvedTone = tone ?? variant ?? "info";
      setToasts((current) => [
        ...current,
        { id, title, body: body ?? description, tone: resolvedTone }
      ]);

      // Errors stay until dismissed. Info and success are confirmations --
      // read once, then gone.
      if (resolvedTone !== "error") {
        const timer = setTimeout(
          () => dismiss(id),
          duration ?? DEFAULT_DURATION
        );
        timers.current.set(id, timer);
      }
    },
    [dismiss]
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({ toast, show: toast, dismiss }),
    [toast, dismiss]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/*
        The region is always mounted, empty or not: a live region inserted at
        the same moment as its first message is frequently not announced.
        `polite` rather than `assertive` even for errors — nothing here
        interrupts a deadline-pressed user mid-sentence.
      */}
      <div
        role="status"
        aria-live="polite"
        aria-relevant="additions text"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-[22rem] flex-col gap-2"
      >
        {toasts.map((item) => (
          <div
            key={item.id}
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-panel border p-3 shadow-pop",
              "motion-safe:animate-pop-in",
              toneStyles[item.tone]
            )}
          >
            <ToastIcon tone={item.tone} />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-sm font-medium">{item.title}</p>
              {item.body ? (
                <p className="text-xs text-ink-muted">{item.body}</p>
              ) : null}
            </div>
            <IconButton
              aria-label="Dismiss"
              size="sm"
              className="-mr-1 -mt-1 ml-auto"
              onClick={() => dismiss(item.id)}
            >
              <X />
            </IconButton>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
