/**
 * Class-name joiner for the component layer.
 *
 * `tailwind-merge` is what makes a `className` prop on a primitive actually
 * override the primitive's own classes instead of appending a losing duplicate
 * (last-wins in the class string, not in the stylesheet). Every component here
 * ends its class list with `className` so a consumer can override.
 */

import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge has to be told about scale keys the config invents, or it
 * cannot know they conflict with anything.
 *
 * This is not cosmetic. An unknown key is passed through untouched, so BOTH
 * classes survive into the DOM and the winner is decided by the order
 * Tailwind happened to emit them in the stylesheet, not by the order the
 * caller wrote them. `max-w-measure` sorts after `max-w-[58rem]`
 * alphabetically, so a DialogContent asking for 58rem silently rendered at
 * 72ch -- the override looked applied in the source and was not.
 *
 * Every key added to `theme.extend` below must be listed here too.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      // theme.extend.maxWidth
      "max-w": ["max-w-measure"],
      // theme.transitionDuration (a replacement, but these are custom keys)
      duration: ["duration-120", "duration-180"],
      // theme.extend.transitionTimingFunction
      ease: ["ease-ledger"]
    }
  }
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * The one focus ring in the app: 2px seal with an offset, per the contract.
 * `focus-visible` rather than `focus` so a mouse click on a button does not
 * leave a ring behind, but keyboard traversal always shows one.
 *
 * Radix primitives are focused programmatically in some flows (a Dialog
 * autofocusing its first control), where the browser does set `:focus-visible`
 * — so this covers those too.
 */
export const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-seal focus-visible:ring-offset-2 focus-visible:ring-offset-paper";

/**
 * Variant of the ring for controls that sit on `--surface` rather than on the
 * app background, so the 2px offset gap matches what is behind the control.
 */
export const focusRingOnSurface =
  "outline-none focus-visible:ring-2 focus-visible:ring-seal focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
