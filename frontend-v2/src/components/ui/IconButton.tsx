/**
 * Square icon-only button.
 *
 * `aria-label` is required by the type, not merely documented: an icon-only
 * control with no label is an unnamed control, and the compiler is the only
 * place that reliably catches it. `Omit`ting the optional `aria-label` from
 * the base props and re-declaring it is what makes it non-optional.
 */

import { forwardRef } from "react";
import { cn, focusRing } from "./cn";
import { Spinner } from "./Spinner";
import type { ButtonVariant } from "./Button";

export type IconButtonSize = "sm" | "md";

export interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Required: this is the control's only accessible name. */
  "aria-label": string;
  variant?: ButtonVariant;
  size?: IconButtonSize;
  loading?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-seal text-surface border border-seal hover:bg-seal/90 active:bg-seal/80",
  secondary:
    "bg-surface text-ink border border-rule hover:bg-sunken active:bg-sunken",
  ghost:
    "bg-transparent text-ink-muted border border-transparent hover:bg-sunken hover:text-ink active:bg-sunken",
  danger:
    "bg-vermilion text-on-vermilion border border-vermilion hover:bg-vermilion/90 active:bg-vermilion/80"
};

// Square: width tracks height exactly, so the hit area is predictable in a
// toolbar row.
const sizes: Record<IconButtonSize, string> = {
  sm: "h-6 w-6 [&_svg]:h-3 [&_svg]:w-3",
  md: "h-8 w-8 [&_svg]:h-4 [&_svg]:w-4"
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      variant = "ghost",
      size = "md",
      loading = false,
      disabled,
      className,
      children,
      type = "button",
      ...rest
    },
    ref
  ) {
    const inert = disabled === true || loading;

    return (
      <button
        ref={ref}
        type={type}
        disabled={inert}
        aria-busy={loading || undefined}
        className={cn(
          "inline-flex shrink-0 select-none items-center justify-center rounded-control",
          "transition-colors duration-120 ease-ledger",
          "disabled:pointer-events-none disabled:opacity-50",
          focusRing,
          variants[variant],
          sizes[size],
          className
        )}
        {...rest}
      >
        {loading ? <Spinner size={size} /> : children}
      </button>
    );
  }
);
