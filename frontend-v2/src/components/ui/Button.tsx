/**
 * The app's button.
 *
 * Deliberately not a Radix `Slot`-based `asChild` component: v2 has no case
 * where a button must render as an anchor, and `asChild` makes the rendered
 * element unknowable from the call site. Composition happens through children
 * (icon + label) instead.
 *
 * `loading` keeps the label visible rather than swapping it for a spinner.
 * Replacing "Draft reply" with a bare spinner loses the only text that tells a
 * screen-reader user — or a user glancing back at the window — what is in
 * flight, and it reflows the layout as the button changes width.
 */

import { forwardRef } from "react";
import { cn, focusRing } from "./cn";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Sets `aria-busy`, blocks activation, keeps the label. */
  loading?: boolean;
  /** Leading icon. Decorative — the label carries the accessible name. */
  icon?: React.ReactNode;
}

const variants: Record<ButtonVariant, string> = {
  // The seal is the one accent: primary actions only.
  primary:
    "bg-seal text-surface border border-seal hover:bg-seal/90 active:bg-seal/80",
  secondary:
    "bg-surface text-ink border border-rule hover:bg-sunken active:bg-sunken",
  // No border: ghost buttons sit inside already-ruled containers, and a border
  // here would read as a second rule.
  ghost:
    "bg-transparent text-ink border border-transparent hover:bg-sunken active:bg-sunken",
  // Vermilion is reserved for destructive actions, deadlines and errors.
  danger:
    "bg-vermilion text-on-vermilion border border-vermilion hover:bg-vermilion/90 active:bg-vermilion/80"
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-6 gap-1 px-2 text-xs",
  md: "h-8 gap-2 px-3 text-sm"
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      loading = false,
      icon,
      disabled,
      className,
      children,
      type = "button",
      ...rest
    },
    ref
  ) {
    // Disabled rather than aria-disabled: a loading button should drop out of
    // the tab order's activation path entirely, not accept a click that is
    // then swallowed.
    const inert = disabled === true || loading;

    return (
      <button
        ref={ref}
        // Default to "button": an unqualified <button> inside a form submits,
        // which is almost never what a toolbar control here means.
        type={type}
        disabled={inert}
        aria-busy={loading || undefined}
        className={cn(
          "inline-flex select-none items-center justify-center whitespace-nowrap rounded-control font-medium",
          "transition-colors duration-120 ease-ledger",
          "disabled:pointer-events-none disabled:opacity-50",
          focusRing,
          variants[variant],
          sizes[size],
          className
        )}
        {...rest}
      >
        {loading ? <Spinner size={size} /> : icon}
        {children}
      </button>
    );
  }
);
