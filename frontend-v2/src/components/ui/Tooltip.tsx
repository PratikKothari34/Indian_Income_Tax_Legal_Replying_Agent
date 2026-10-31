/**
 * Tooltip, wrapping `@radix-ui/react-tooltip`.
 *
 * A tooltip is supplementary by rule: Radix does not expose its content to
 * touch users at all, and the trigger keeps its own `aria-label`. Anything a
 * user must read to operate a control belongs in a Field hint, not here.
 *
 * `TooltipProvider` must wrap the app once so the shared open/close delay is
 * consistent and only one tooltip is open at a time.
 */

import { forwardRef } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "./cn";

export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export type TooltipProviderProps = React.ComponentPropsWithoutRef<
  typeof TooltipPrimitive.Provider
>;

export function TooltipProvider({
  delayDuration = 400,
  skipDelayDuration = 200,
  ...rest
}: TooltipProviderProps) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...rest}
    />
  );
}

export type TooltipContentProps = React.ComponentPropsWithoutRef<
  typeof TooltipPrimitive.Content
>;

export const TooltipContent = forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  TooltipContentProps
>(function TooltipContent({ className, sideOffset = 6, ...rest }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          // Inverted: a tooltip reads as a label on top of the UI, not as
          // another surface competing with it.
          "z-50 max-w-[18rem] rounded-control bg-ink px-2 py-1 text-xs text-paper",
          "motion-safe:animate-pop-in",
          className
        )}
        {...rest}
      />
    </TooltipPrimitive.Portal>
  );
});

/** Shorthand for the common trigger + single line of text case. */
export function Tooltip({
  content,
  children,
  side = "top",
  ...rest
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: TooltipContentProps["side"];
} & Omit<React.ComponentPropsWithoutRef<typeof TooltipRoot>, "children">) {
  return (
    <TooltipRoot {...rest}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </TooltipRoot>
  );
}
