/**
 * Panel — the app's one container.
 *
 * No shadow, by contract: panels are separated by 1px rules, not by floating
 * cards with a soft grey drop shadow. Shadows exist only on genuinely floating
 * layers (Popover, Select content, Dialog). If a panel needs to feel lifted,
 * the answer is a rule or a sunken neighbour, not `shadow-pop`.
 */

import { forwardRef } from "react";
import { cn } from "./cn";

export interface PanelProps extends React.HTMLAttributes<HTMLElement> {
  /** Wells, code blocks and the notice pane sit on the sunken paper tone. */
  sunken?: boolean;
  /** Pass false when the panel's children own their own padding. */
  padded?: boolean;
  /** Renders as <section>; pair with an accessible name when used for one. */
  as?: "div" | "section" | "aside";
}

// Ref is HTMLElement rather than HTMLDivElement because `as` can swap the tag;
// all three options are HTMLElement and none adds members a consumer needs.
export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel(
  { sunken = false, padded = true, as: Tag = "div", className, ...rest },
  ref
) {
  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement>}
      className={cn(
        "rounded-panel border border-rule",
        sunken ? "bg-sunken" : "bg-surface",
        padded && "p-4",
        className
      )}
      {...rest}
    />
  );
});

/**
 * Header strip for a Panel: a title row closed by a rule rather than by a gap.
 * Use with `padded={false}` on the Panel so the rule spans its full width.
 */
export function PanelHeader({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 border-b border-rule px-4 py-2",
        className
      )}
      {...rest}
    />
  );
}

/** Title inside a PanelHeader. Sentence case, no eyebrow, no tracking. */
export function PanelTitle({
  className,
  ...rest
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn("text-sm font-semibold text-ink", className)}
      {...rest}
    />
  );
}

/** Body of a Panel used with `padded={false}`. */
export function PanelBody({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...rest} />;
}
