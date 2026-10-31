/**
 * A segmented control: two or three fixed choices, all visible, one click.
 *
 * Use it instead of a `Select` when the options are few and stable. A select
 * costs two clicks and hides the alternatives behind the first one, which is
 * the wrong trade when there are only two and both fit on a row. Past about
 * four options, or when the set is variable (the model list, the weekday),
 * go back to `Select`.
 *
 * Hand-rolled rather than `@radix-ui/react-radio-group`, which is not a
 * dependency here and is not worth adding for forty lines. It still behaves
 * like a radio group, because that is what a choice between alternatives is:
 * `role="radiogroup"` on the wrapper, `role="radio"` with `aria-checked` on
 * each option, **one tab stop** (only the checked option is tabbable), and
 * arrow keys to move between them. A row of plain buttons would put three tab
 * stops in the way of every keyboard user and announce "button", not "2 of 3".
 */

import { useRef, type KeyboardEvent } from "react";
import { cn, focusRingOnSurface } from "./cn";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
};

export type SegmentedControlProps<T extends string> = {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  disabled?: boolean;
  /** Names the group. Required: the options alone do not say what they set. */
  "aria-label": string;
  id?: string;
  className?: string;
};

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  disabled = false,
  "aria-label": ariaLabel,
  id,
  className
}: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  // Arrow keys move the selection AND the focus together, which is the
  // standard radio-group behaviour: there is no "focused but unselected"
  // state to get lost in. Home/End jump to the ends.
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = options.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = index === last ? 0 : index + 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = index === 0 ? last : index - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = last;
    }
    if (next === null) return;
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  }

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-px rounded-control border border-rule bg-sunken p-px",
        disabled && "cursor-not-allowed opacity-60",
        className
      )}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            // One tab stop for the whole group, landing on the current value.
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "rounded-control px-3 py-1 text-sm transition-colors duration-120 ease-ledger",
              focusRingOnSurface,
              // The checked segment is a raised surface against the sunken
              // track, so the state reads from shape as well as weight and is
              // not carried by colour alone.
              checked
                ? "bg-surface font-medium text-ink shadow-pop"
                : "text-ink-muted hover:text-ink",
              disabled && "cursor-not-allowed hover:text-ink-muted"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
