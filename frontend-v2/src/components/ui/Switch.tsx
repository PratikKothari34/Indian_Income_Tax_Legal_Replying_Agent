/**
 * Switch, wrapping `@radix-ui/react-switch`.
 *
 * Off-state track is `--rule` rather than a wash: the on/off difference has to
 * clear 3:1 against the surface in both themes, and a tinted wash does not in
 * dark mode. Seal when on, rule when off.
 */

import { forwardRef, useId } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn, focusRingOnSurface } from "./cn";

export type SwitchProps = React.ComponentPropsWithoutRef<
  typeof SwitchPrimitive.Root
> & {
  /** Renders a clickable label beside the switch. */
  label?: React.ReactNode;
  /** Secondary line under the label. Wired via `aria-describedby`. */
  description?: React.ReactNode;
};

export const Switch = forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  SwitchProps
>(function Switch({ className, label, description, id, ...rest }, ref) {
  const generated = useId();
  const controlId = id ?? generated;
  const descriptionId = `${controlId}-description`;

  const control = (
    <SwitchPrimitive.Root
      ref={ref}
      id={controlId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn(
        "relative inline-flex h-4 w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent",
        "transition-colors duration-120 ease-ledger",
        // The off state is the whole control: at --rule it is a 1.15:1 smudge
        // against the surface, so an unchecked switch reads as nothing at all.
        "data-[state=checked]:bg-seal data-[state=unchecked]:bg-rule-strong",
        "disabled:cursor-not-allowed disabled:opacity-50",
        focusRingOnSurface,
        className
      )}
      {...rest}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block h-3 w-3 rounded-full bg-surface",
          "transition-transform duration-120 ease-ledger",
          // Travel = track(32) - thumb(12) - 2x inset(1) = 18px.
          // `translate-x-4` is 16px and left the thumb 1px from the left
          // when off but 3px from the right when on -- visibly lopsided on
          // a 32px control. The spacing scale is replaced and has no 4.5
          // key, so this is an arbitrary value by necessity.
          "translate-x-px data-[state=checked]:translate-x-[18px]"
        )}
      />
    </SwitchPrimitive.Root>
  );

  if (!label && !description) return control;

  return (
    <div className="flex items-start gap-3">
      {/* mt-1 optically centres the 16px track against the first text line. */}
      <span className="mt-1 shrink-0">{control}</span>
      <span className="flex flex-col gap-1">
        {label ? (
          <LabelPrimitive.Root
            htmlFor={controlId}
            className="text-sm font-medium text-ink"
          >
            {label}
          </LabelPrimitive.Root>
        ) : null}
        {description ? (
          <span id={descriptionId} className="text-xs text-ink-faint">
            {description}
          </span>
        ) : null}
      </span>
    </div>
  );
});
