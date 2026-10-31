/**
 * Empty state.
 *
 * Per the contract an empty state is an invitation ("Drop a notice to start."),
 * not an apology or a shrug — so the headline is the next action, and the
 * action slot is a real control rather than a hint to go look elsewhere.
 *
 * This is the one place the app centres anything: a genuinely empty pane. The
 * contract's left-alignment rule carves out exactly this case.
 */

import { forwardRef } from "react";
import { cn } from "./cn";

export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "title"> {
  /** Decorative icon. Sized here, so pass the bare component. */
  icon?: React.ReactNode;
  /** The next action, phrased as an invitation. Alias: `title`. */
  headline?: React.ReactNode;
  /** Accepted as a synonym of `headline`. */
  title?: React.ReactNode;
  /** One or two lines of detail. Alias: `description`. */
  body?: React.ReactNode;
  /** Accepted as a synonym of `body`. */
  description?: React.ReactNode;
  action?: React.ReactNode;
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(
  function EmptyState(
    {
      icon,
      headline,
      title,
      body,
      description,
      action,
      className,
      ...rest
    },
    ref
  ) {
    const heading = headline ?? title;
    const detail = body ?? description;

    return (
      <div
        ref={ref}
        className={cn(
          "flex flex-col items-center justify-center gap-2 px-4 py-12 text-center",
          className
        )}
        {...rest}
      >
        {icon ? (
          <span
            aria-hidden="true"
            className="text-ink-faint [&_svg]:h-8 [&_svg]:w-8"
          >
            {icon}
          </span>
        ) : null}
        <p className="text-base font-medium text-ink">{heading}</p>
        {detail ? (
          // max-w keeps the body from running to the full pane width, which at
          // 1.2fr is far past a readable measure for two lines of text.
          <p className="max-w-[36ch] text-sm text-ink-muted">{detail}</p>
        ) : null}
        {action ? <div className="pt-2">{action}</div> : null}
      </div>
    );
  }
);
