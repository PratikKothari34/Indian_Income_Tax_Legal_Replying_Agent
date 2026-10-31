/**
 * Indeterminate progress.
 *
 * Under `prefers-reduced-motion: reduce` the ring stops spinning rather than
 * disappearing: something must still mark the control as busy, so it holds as
 * a static partial ring. The contract disables the draft-stream choreography
 * under that query, not all state feedback.
 */

import { forwardRef } from "react";
import { cn } from "./cn";

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Matches the icon sizes used beside sm/md control labels. */
  size?: "sm" | "md";
}

const sizes: Record<NonNullable<SpinnerProps["size"]>, string> = {
  sm: "h-3 w-3",
  md: "h-4 w-4"
};

export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(
  function Spinner({ size = "md", className, ...rest }, ref) {
    return (
      <span
        ref={ref}
        // Decorative: the busy state is announced by aria-busy on the control
        // or by the live region that owns the status text.
        aria-hidden="true"
        className={cn(
          "inline-block shrink-0 rounded-full border-2 border-current border-r-transparent",
          "motion-safe:animate-spin",
          sizes[size],
          className
        )}
        {...rest}
      />
    );
  }
);
