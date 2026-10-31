/**
 * Slider, wrapping `@radix-ui/react-slider`.
 *
 * Accepts a scalar `value` as well as Radix's array, because almost every use
 * here is a single setting (temperature) and `value={[t]}` /
 * `onValueChange={([v]) => …}` at each call site is where an off-by-one
 * destructure gets written. A scalar in gives a scalar back out; an array in
 * gives an array, and renders one thumb per entry.
 */

import { forwardRef } from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn, focusRingOnSurface } from "./cn";

type RadixSliderProps = React.ComponentPropsWithoutRef<
  typeof SliderPrimitive.Root
>;

/**
 * `onValueChange` is called with a scalar when `value`/`defaultValue` was a
 * scalar, and with the array otherwise — so a caller declares whichever of
 * the two signatures matches the shape it passed in.
 */
export type SliderProps = Omit<
  RadixSliderProps,
  "value" | "defaultValue" | "onValueChange" | "onValueCommit"
> & {
  value?: number | number[];
  defaultValue?: number | number[];
  onValueChange?: ((value: number) => void) | ((value: number[]) => void);
  onValueCommit?: ((value: number) => void) | ((value: number[]) => void);
};

function toArray(value: number | number[] | undefined): number[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

export const Slider = forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  SliderProps
>(function Slider(
  {
    className,
    value,
    defaultValue,
    onValueChange,
    onValueCommit,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    "aria-valuetext": ariaValueText,
    ...rest
  },
  ref
) {
  const scalar = typeof (value ?? defaultValue) === "number";
  const values = toArray(value);
  const defaults = toArray(defaultValue);
  const thumbCount = (values ?? defaults)?.length ?? 1;

  // Hand the caller back the same shape it passed in. The cast is confined to
  // these two adapters rather than leaking into the public prop types.
  const adapt = (
    handler: SliderProps["onValueChange"]
  ): ((next: number[]) => void) | undefined => {
    if (!handler) return undefined;
    return (next: number[]) => {
      const fn = handler as (arg: number | number[]) => void;
      fn(scalar ? (next[0] ?? 0) : next);
    };
  };

  return (
    <SliderPrimitive.Root
      ref={ref}
      value={values}
      defaultValue={defaults}
      onValueChange={adapt(onValueChange)}
      onValueCommit={adapt(onValueCommit)}
      className={cn(
        "relative flex w-full touch-none select-none items-center",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...rest}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-rule">
        <SliderPrimitive.Range className="absolute h-full bg-seal" />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbCount }, (_unused, index) => (
        <SliderPrimitive.Thumb
          key={index}
          // Radix puts role="slider" on the Thumb, not the Root, so the
          // naming attributes have to land here: on the Root they sit on a
          // roleless <span>, and a <label for> cannot bind to it either.
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-valuetext={ariaValueText}
          className={cn(
            "block h-4 w-4 rounded-full border-2 border-seal bg-surface",
            "transition-colors duration-120 ease-ledger",
            focusRingOnSurface
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
});
