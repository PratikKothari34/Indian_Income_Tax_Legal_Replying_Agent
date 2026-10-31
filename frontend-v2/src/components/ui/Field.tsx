/**
 * Label + control wrapper.
 *
 * The wiring problem this solves: a hint and an error both need to reach the
 * control through `aria-describedby`, and the ids have to be stable and unique
 * per field. Field owns the ids (via `useId`) and hands them back through a
 * render callback, so the control cannot drift out of sync with the text
 * describing it.
 *
 * Children may be a plain node — for a Radix control that manages its own
 * labelling — or a function receiving the derived a11y props to spread.
 */

import { useId } from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "./cn";

/** What a control needs to be correctly described by this field's text. */
export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
}

export interface FieldProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  label: React.ReactNode;
  /**
   * Id of a control the caller renders and ids itself. Without it the field
   * generates an id and the caller spreads it via the render-callback form.
   */
  htmlFor?: string;
  /** Persistent help text. Hidden from the description once an error shows. */
  hint?: React.ReactNode;
  /**
   * Present means invalid: sets `aria-invalid` and renders in vermilion.
   * `null` is accepted so a caller can pass a nullable validation result
   * straight through without collapsing it to undefined first.
   */
  error?: React.ReactNode | null;
  /** Renders an "optional" marker instead of flagging required fields. */
  optional?: boolean;
  /**
   * `"stack"` (the default) puts the control under the label, full width.
   * `"row"` puts the label and its hint on the left and the control hard
   * right, which is how a settings list reads: the labels form one scannable
   * column and the controls another.
   *
   * `"row"` is opt-in per field, not a panel-wide switch, because it only
   * works for a control with its own natural width -- a switch, a short
   * select, a segmented control. A text input or a path field with a Browse
   * button beside it needs the whole line and must stay `"stack"`, or the
   * label and the control fight over the same space.
   *
   * Below the `settings` breakpoint it falls back to the stacked layout
   * regardless: at that width a long label and a control on one line
   * collide. See `tailwind.config.ts` for why that screen exists.
   */
  layout?: "stack" | "row";
  children: React.ReactNode | ((props: FieldControlProps) => React.ReactNode);
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  optional = false,
  layout = "stack",
  className,
  children,
  ...rest
}: FieldProps) {
  const base = useId();
  const controlId = htmlFor ?? `${base}-control`;
  const hintId = `${base}-hint`;
  const errorId = `${base}-error`;

  // The error replaces the hint in the description rather than appending to
  // it: a screen reader reading both makes the actionable half arrive second.
  const describedBy = error ? errorId : hint ? hintId : undefined;

  const controlProps: FieldControlProps = {
    id: controlId,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined
  };

  const labelEl = (
    <LabelPrimitive.Root
      htmlFor={controlId}
      className="flex items-baseline gap-2 text-sm font-medium text-ink"
    >
      {label}
      {optional ? (
        <span className="text-xs font-normal text-ink-faint">optional</span>
      ) : null}
    </LabelPrimitive.Root>
  );

  const hintEl =
    hint && !error ? (
      <p id={hintId} className="text-xs text-ink-faint">
        {hint}
      </p>
    ) : null;

  const errorEl = error ? (
    <p id={errorId} className="text-xs text-vermilion">
      {error}
    </p>
  ) : null;

  const control = typeof children === "function" ? children(controlProps) : children;

  if (layout === "row") {
    return (
      <div
        className={cn(
          "flex flex-col gap-2 settings:flex-row settings:items-center settings:justify-between settings:gap-6",
          className
        )}
        {...rest}
      >
        {/* `basis-0 grow` with a floor, not `min-w-0` alone: a flex item
            whose minimum is zero will be crushed to one word per line by a
            wide control beside it, which is exactly what a long label did.
            The floor means the control gives way first, and below it the
            whole row has already stacked. */}
        <div className="flex flex-col gap-1 settings:min-w-[16rem] settings:flex-1 settings:basis-0">
          {labelEl}
          {hintEl}
          {errorEl}
        </div>
        {/* `shrink-0` so a long hint on the left never squeezes the control
            below its own minimum; the hint wraps instead. */}
        <div className="shrink-0">{control}</div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1", className)} {...rest}>
      {labelEl}
      {control}
      {hintEl}
      {errorEl}
    </div>
  );
}
