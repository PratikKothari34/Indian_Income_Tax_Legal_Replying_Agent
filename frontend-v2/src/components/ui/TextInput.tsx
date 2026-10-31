/**
 * Single-line text input.
 *
 * The focus ring here is `focus-visible`-independent — it uses `:focus` —
 * because a text input that is clicked into *should* show the ring: unlike a
 * button, a focused input stays focused and the user needs to see where typing
 * lands.
 */

import { forwardRef } from "react";
import { cn } from "./cn";

export interface TextInputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Section refs, ids and paths are mono per the type contract. */
  mono?: boolean;
  /**
   * Leading decorative icon (a search glass, typically). Wrapping only
   * happens when this is set, so the plain case stays a bare <input> and the
   * `className` a consumer passes still lands on the control.
   */
  icon?: React.ReactNode;
}

export const inputBase =
  "w-full rounded-control border bg-surface px-2 text-sm text-ink placeholder:text-ink-faint " +
  "outline-none transition-colors duration-120 ease-ledger " +
  "focus:ring-2 focus:ring-seal focus:ring-offset-2 focus:ring-offset-surface " +
  "disabled:cursor-not-allowed disabled:bg-sunken disabled:text-ink-faint " +
  // Invalid state is driven by aria-invalid, which Field already sets, so the
  // border does not need a separate prop threaded through.
  // The border is the only thing marking where the field is, so it uses
  // rule-strong: 1.4.11 asks 3:1 for a control boundary, which plain --rule
  // does not reach.
  "border-rule-strong aria-[invalid=true]:border-vermilion aria-[invalid=true]:focus:ring-vermilion";

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput(
    { mono = false, icon, className, type = "text", ...rest },
    ref
  ) {
    const control = (
      <input
        ref={ref}
        type={type}
        className={cn(
          inputBase,
          "h-8",
          mono && "font-mono",
          // Room for the icon that is absolutely positioned over the field.
          icon && "pl-8",
          className
        )}
        {...rest}
      />
    );

    if (!icon) return control;

    return (
      <span className="relative block">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint [&_svg]:h-4 [&_svg]:w-4"
        >
          {icon}
        </span>
        {control}
      </span>
    );
  }
);
