/**
 * Popover, wrapping `@radix-ui/react-popover`.
 *
 * Unlike Tooltip this is focusable content — Radix moves focus into it on
 * open and returns it to the trigger on close, so it is the right primitive
 * for a citation detail card or a filter form, and the wrong one for a hint.
 */

import { forwardRef } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn, focusRingOnSurface } from "./cn";

export const PopoverRoot = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export type PopoverContentProps = React.ComponentPropsWithoutRef<
  typeof PopoverPrimitive.Content
>;

export const PopoverContent = forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  PopoverContentProps
>(function PopoverContent(
  { className, align = "start", sideOffset = 6, ...rest },
  ref
) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        // start, not center: the app is left-aligned throughout.
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-full max-w-[22rem] rounded-panel border border-rule bg-surface p-4 shadow-pop",
          "motion-safe:animate-pop-in",
          focusRingOnSurface,
          className
        )}
        {...rest}
      />
    </PopoverPrimitive.Portal>
  );
});
