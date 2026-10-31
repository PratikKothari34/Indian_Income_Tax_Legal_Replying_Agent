/**
 * A clock dial for picking a time of day.
 *
 * Replaces, in order: `<input type="time">` (WebView2 draws its own picker
 * in OS chrome that the token system cannot reach) and then a 48-item
 * grouped select (themed, but reaching 2:30 am meant scrolling past twenty
 * other rows). A clock face is spatial -- 2 o'clock is a *place*, so the
 * hour is one click rather than a scroll and a search.
 *
 * Two rings, picked in sequence the way a clock is read: hours first, then
 * minutes. The ring switches itself after the hour is set, because having
 * chosen an hour the next thing anyone wants is the minute.
 *
 * ## Keyboard
 *
 * A dial that only responds to a pointer would be a regression -- the select
 * it replaces was fully operable by keyboard. So the face is one composite
 * widget (`role="application"` would swallow arrows; a `spinbutton` per
 * value is what screen readers already understand):
 *
 * - The hour and minute readouts are each a `spinbutton`. Arrow up/down
 *   steps, Page up/down jumps, Home/End go to the ends.
 * - Tab moves between them, so nothing needs the dial at all.
 * - The face is `aria-hidden`: it is a second, redundant way to reach the
 *   same two values, and announcing twelve unlabelled buttons would be
 *   noise.
 *
 * ## Minutes
 *
 * Five-minute steps on the ring, because twelve labelled positions is what a
 * clock face has room for and a background sync does not need 11:37. The
 * spinbutton steps by 5 too, and Advanced takes any cron for the rare exact
 * minute. A stored value off the step is shown as-is rather than snapped --
 * the dial renders its hand at the true angle, so an inherited 02:37 reads
 * correctly even though the ring cannot produce it.
 */

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { cn, focusRing } from "./cn";

/** Minutes between adjacent positions on the minute ring. */
const MINUTE_STEP = 5;

/** Geometry, in the SVG's own user units. The box is 200x200. */
const CENTER = 100;
const FACE_RADIUS = 92;
// Minutes sit outside the hours, as they do on a real clock. The two rings
// had the same radius once, and switching ring then moved nothing on the
// face: twelve numerals were replaced by twelve others in the same twelve
// places, so a second click at the same spot set :15 instead of 3 o'clock.
const HOUR_RADIUS = 62;
const MINUTE_RADIUS = 78;

export type TimeDialProps = {
  /** `HH:MM`, 24-hour. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Labels the pair of spinbuttons for assistive technology. */
  "aria-label"?: string;
  id?: string;
};

type Ring = "hours" | "minutes";

/** `HH:MM` -> parts, or null. Mirrors `format.ts::parseHhMm`, kept local so
 *  this component has no dependency on the schedule module. */
function parse(value: string): { hour: number; minute: number } | null {
  const parts = value.split(":");
  if (parts.length !== 2) return null;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function toHhMm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Where a value sits on its ring, in SVG coordinates.
 *
 * `turns` is the fraction around the dial clockwise from the top. SVG's y
 * axis points down, which is why the sine term is subtracted: without that
 * the clock runs backwards.
 */
function pointOn(radius: number, turns: number): { x: number; y: number } {
  const angle = turns * 2 * Math.PI;
  return {
    x: CENTER + radius * Math.sin(angle),
    y: CENTER - radius * Math.cos(angle)
  };
}

/** The inverse: a point in SVG coordinates -> fraction around the dial. */
function turnsAt(x: number, y: number): number {
  const angle = Math.atan2(x - CENTER, CENTER - y);
  return (angle / (2 * Math.PI) + 1) % 1;
}

const HOURS_OUTER = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

export function TimeDial({
  value,
  onChange,
  disabled = false,
  "aria-label": ariaLabel = "Time",
  id
}: TimeDialProps) {
  const parsed = parse(value);
  const hour = parsed?.hour ?? 12;
  const minute = parsed?.minute ?? 0;

  // Hours first. Radix unmounts the popover's content on close, so this
  // initializer runs on every open and no reset effect is needed.
  const [ring, setRing] = useState<Ring>("hours");
  const faceRef = useRef<SVGSVGElement | null>(null);
  const dragging = useRef(false);
  const headingId = useId();

  const isPm = hour >= 12;
  /** The hour as the face shows it: 12 at the top, not 0. */
  const faceHour = hour % 12 === 0 ? 12 : hour % 12;

  const setHour = useCallback(
    (nextFaceHour: number, pm: boolean) => {
      const h = (nextFaceHour % 12) + (pm ? 12 : 0);
      onChange(toHhMm(h, minute));
    },
    [minute, onChange]
  );

  const setMinute = useCallback(
    (next: number) => {
      onChange(toHhMm(hour, ((next % 60) + 60) % 60));
    },
    [hour, onChange]
  );

  /** Pointer position -> the value under it, applied. */
  const applyPointer = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const svg = faceRef.current;
      if (!svg || disabled) return;
      const rect = svg.getBoundingClientRect();
      // The viewBox is square and `preserveAspectRatio` is the default, so a
      // simple proportional map is correct at any rendered size.
      const x = ((event.clientX - rect.left) / rect.width) * 200;
      const y = ((event.clientY - rect.top) / rect.height) * 200;
      const turns = turnsAt(x, y);

      if (ring === "hours") {
        const slot = Math.round(turns * 12) % 12;
        setHour(slot === 0 ? 12 : slot, isPm);
      } else {
        const slot = Math.round((turns * 60) / MINUTE_STEP) * MINUTE_STEP;
        setMinute(slot);
      }
    },
    [disabled, isPm, ring, setHour, setMinute]
  );

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    applyPointer(event);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    applyPointer(event);
  };

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // Having set the hour, the minute is what comes next. Only on release,
    // so a drag around the hour ring does not switch out from under the
    // finger mid-gesture.
    if (ring === "hours") setRing("minutes");
  };

  /**
   * Arrow-key handling for a readout.
   *
   * `min`/`max` are inclusive and the value wraps between them, because a
   * clock is a circle: stepping down from 1 o'clock reaches 12, not a dead
   * stop. Hours run 1..12 and minutes 0..59, so the domain is passed in
   * rather than assumed from `max`.
   */
  const spinKeys = (
    event: React.KeyboardEvent,
    current: number,
    step: number,
    min: number,
    max: number,
    apply: (next: number) => void
  ) => {
    const span = max - min + 1;
    const wrap = (n: number) => min + ((((n - min) % span) + span) % span);
    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        apply(wrap(current + step));
        break;
      case "ArrowDown":
      case "ArrowLeft":
        apply(wrap(current - step));
        break;
      // A page jump is a quarter turn of the dial either way -- 3 hours, or
      // 15 minutes.
      case "PageUp":
        apply(wrap(current + step * 3));
        break;
      case "PageDown":
        apply(wrap(current - step * 3));
        break;
      case "Home":
        apply(min);
        break;
      case "End":
        // The last value actually on the step, which for minutes is 55, not
        // 59 -- End must land somewhere an arrow key could also reach.
        apply(min + Math.floor((max - min) / step) * step);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const hourHand = useMemo(
    () => pointOn(HOUR_RADIUS, (faceHour % 12) / 12),
    [faceHour]
  );
  const minuteHand = useMemo(
    () => pointOn(MINUTE_RADIUS, minute / 60),
    [minute]
  );
  const activeHand = ring === "hours" ? hourHand : minuteHand;

  const readout = (
    kind: Ring,
    text: string,
    now: number,
    step: number,
    min: number,
    max: number,
    apply: (n: number) => void,
    label: string
  ) => (
    <button
      type="button"
      role="spinbutton"
      aria-label={label}
      aria-valuenow={now}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={text}
      disabled={disabled}
      // Focus, not click, selects the ring. A native button fires its click
      // on Space and Enter, neither of which means anything to a spinbutton,
      // so clicking to switch made those two keys silently change the ring.
      // Driving it from focus makes Tab and the face agree instead.
      onFocus={() => setRing(kind)}
      onKeyDown={(e) => spinKeys(e, now, step, min, max, apply)}
      className={cn(
        "rounded-control px-2 py-1 font-mono text-xl tabular-nums",
        "border-b-2 transition-colors duration-120 ease-ledger",
        focusRing,
        ring === kind
          ? "border-seal bg-seal-wash text-seal"
          : "border-transparent text-ink hover:bg-sunken",
        disabled && "cursor-not-allowed opacity-60"
      )}
    >
      {text}
    </button>
  );

  const meridiem = (pm: boolean, text: string) => (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={isPm === pm}
      onClick={() => setHour(faceHour, pm)}
      className={cn(
        "rounded-control px-2 py-1 text-xs font-semibold transition-colors duration-120 ease-ledger",
        focusRing,
        isPm === pm
          ? "bg-seal text-surface"
          : "text-ink-muted hover:bg-sunken hover:text-ink",
        disabled && "cursor-not-allowed opacity-60"
      )}
    >
      {text}
    </button>
  );

  return (
    <div
      id={id}
      // `group`, not a bare div: `aria-labelledby` is prohibited on the
      // generic role, so without this the label prop is dropped outright.
      role="group"
      className="flex flex-col items-center gap-3"
      aria-labelledby={headingId}
    >
      <span id={headingId} className="sr-only">
        {ariaLabel}
      </span>

      <div className="flex items-center gap-1">
        {readout("hours", String(faceHour), faceHour, 1, 1, 12,
          (n) => setHour(n, isPm), "Hour")}
        <span className="font-mono text-xl text-ink-faint">:</span>
        {readout("minutes", String(minute).padStart(2, "0"), minute,
          MINUTE_STEP, 0, 59, setMinute, "Minutes")}
        <div className="ml-2 flex flex-col gap-1">
          {meridiem(false, "AM")}
          {meridiem(true, "PM")}
        </div>
      </div>

      <svg
        ref={faceRef}
        viewBox="0 0 200 200"
        // Redundant with the two spinbuttons above, which are what assistive
        // technology should see. Twelve unlabelled tick marks would be noise.
        aria-hidden="true"
        className={cn(
          "aspect-square w-full max-w-[200px] touch-none select-none",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <circle cx={CENTER} cy={CENTER} r={FACE_RADIUS}
          className="fill-sunken stroke-rule-strong" strokeWidth={1} />

        {/* The hand. Drawn before the numbers so they sit on top of it. */}
        <line x1={CENTER} y1={CENTER} x2={activeHand.x} y2={activeHand.y}
          className="stroke-seal" strokeWidth={2} strokeLinecap="round" />
        <circle cx={activeHand.x} cy={activeHand.y} r={14}
          className="fill-seal" />
        <circle cx={CENTER} cy={CENTER} r={3} className="fill-seal" />

        {ring === "hours"
          ? HOURS_OUTER.map((h, i) => {
              const p = pointOn(HOUR_RADIUS, i / 12);
              const on = h === faceHour;
              return (
                <text key={h} x={p.x} y={p.y}
                  textAnchor="middle" dominantBaseline="central"
                  className={cn(
                    "pointer-events-none select-none font-mono text-sm",
                    on ? "fill-surface" : "fill-ink-muted"
                  )}>
                  {h}
                </text>
              );
            })
          : Array.from({ length: 12 }, (_, i) => i * MINUTE_STEP).map((m, i) => {
              const p = pointOn(MINUTE_RADIUS, i / 12);
              const on = m === minute;
              return (
                <text key={m} x={p.x} y={p.y}
                  textAnchor="middle" dominantBaseline="central"
                  className={cn(
                    "pointer-events-none select-none font-mono text-sm",
                    on ? "fill-surface" : "fill-ink-muted"
                  )}>
                  {String(m).padStart(2, "0")}
                </text>
              );
            })}

        {/* A minute off the 5-step cannot land on a label, so mark it on the
            rim rather than leaving the hand pointing at nothing. */}
        {ring === "minutes" && minute % MINUTE_STEP !== 0 && (
          <circle cx={minuteHand.x} cy={minuteHand.y} r={3}
            className="fill-surface" />
        )}
      </svg>

      <p aria-live="polite" className="text-xs text-ink-faint">
        {ring === "hours" ? "Pick the hour" : "Pick the minutes"}
      </p>
    </div>
  );
}
