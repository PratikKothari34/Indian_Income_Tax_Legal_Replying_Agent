/**
 * Status badge.
 *
 * Wash background with the full-strength colour as text, so a row of badges
 * stays quiet while remaining legible — a saturated fill would make status
 * the loudest thing on the surface, and in this app the citations are.
 *
 * Sentence case only: the contract forbids ALL-CAPS labels, which is the
 * default look for a badge and the reason this component exists rather than
 * an ad-hoc span.
 */

import { forwardRef } from "react";
import { cn } from "./cn";

export type BadgeTone =
  | "neutral"
  | "seal"
  | "viridian"
  | "amber"
  | "vermilion";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Document ids, section refs and counts are mono per the type contract. */
  mono?: boolean;
}

/**
 * The coloured tones carry no border. Measured, a `/20` border sits at
 * 1.32-1.62:1 against its own wash -- a line nobody can see, so it was
 * costing a pixel and rendering nothing. Full strength would clear 3:1 but
 * measures 5.3-10.1:1 against the surface, which would make a row of badges
 * the loudest thing on the page; the comment above says why that is wrong.
 *
 * Dropping it is sound rather than a compromise: a badge is not a control, so
 * the 3:1 boundary rule does not reach it, and its state is already carried by
 * text at 4.7-8.9:1 on the wash. The wash is the shape.
 *
 * `neutral` keeps its border: its fill is `sunken`, which against a sunken
 * surface is the same colour, so without the rule the badge has no edge at all.
 */
const tones: Record<BadgeTone, string> = {
  neutral: "border border-rule bg-sunken text-ink-muted",
  seal: "bg-seal-wash text-seal",
  viridian: "bg-viridian-wash text-viridian",
  amber: "bg-amber-wash text-amber",
  vermilion: "bg-vermilion-wash text-vermilion"
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = "neutral", mono = false, className, ...rest },
  ref
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1 rounded-control px-1 py-px text-xs font-medium",
        tones[tone],
        mono && "font-mono font-normal",
        className
      )}
      {...rest}
    />
  );
});
