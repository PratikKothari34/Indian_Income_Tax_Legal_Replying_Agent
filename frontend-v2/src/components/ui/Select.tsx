/**
 * Select, wrapping `@radix-ui/react-select`.
 *
 * A native `<select>` cannot be styled to the token system on Windows — the
 * popup is drawn by the OS — so Radix owns the listbox. The cost is that
 * keyboard and typeahead behaviour now comes from Radix rather than the
 * platform, which is why nothing here overrides its key handling.
 *
 * `position="popper"` rather than the default item-aligned placement: the
 * work surface is split into narrow panes and an item-aligned popup overflows
 * them.
 */

import { forwardRef } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { cn, focusRingOnSurface } from "./cn";
import { Check, ChevronDown } from "@/components/icons";

export const SelectRoot = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export type SelectTriggerProps = React.ComponentPropsWithoutRef<
  typeof SelectPrimitive.Trigger
>;

export const SelectTrigger = forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(function SelectTrigger({ className, children, ...rest }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        "flex h-8 w-full items-center justify-between gap-2 rounded-control border border-rule-strong bg-surface px-2",
        "text-sm text-ink transition-colors duration-120 ease-ledger",
        "hover:bg-sunken data-[placeholder]:text-ink-faint",
        "disabled:cursor-not-allowed disabled:bg-sunken disabled:text-ink-faint",
        "aria-[invalid=true]:border-vermilion",
        focusRingOnSurface,
        className
      )}
      {...rest}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="h-4 w-4 shrink-0 text-ink-faint" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

/**
 * The scroll affordance on a list taller than the popup.
 *
 * Radix renders these only when the content actually overflows, so they cost
 * nothing on a short select. Without them a long list (the time picker's 48
 * half-hour slots) clips at the viewport edge with nothing to say there is
 * more below -- the keyboard and wheel still work, but the list looks
 * truncated rather than scrollable.
 *
 * `ChevronDown` rotated rather than a second icon: one SVG to keep in step
 * with the icon set instead of two.
 */
function SelectScrollButton({ direction }: { direction: "up" | "down" }) {
  const Button =
    direction === "up"
      ? SelectPrimitive.ScrollUpButton
      : SelectPrimitive.ScrollDownButton;
  return (
    <Button className="flex h-4 items-center justify-center bg-surface text-ink-faint">
      <ChevronDown className={cn("h-3 w-3", direction === "up" && "rotate-180")} />
    </Button>
  );
}

export type SelectContentProps = React.ComponentPropsWithoutRef<
  typeof SelectPrimitive.Content
>;

export const SelectContent = forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Content>,
  SelectContentProps
>(function SelectContent(
  { className, children, position = "popper", sideOffset = 4, ...rest },
  ref
) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={sideOffset}
        className={cn(
          // A genuinely floating layer, so a shadow is allowed here.
          "z-50 overflow-hidden rounded-panel border border-rule bg-surface shadow-pop",
          "motion-safe:animate-pop-in",
          // Radix publishes the trigger width as a custom property; matching
          // it keeps the popup from being narrower than the closed control.
          "min-w-[var(--radix-select-trigger-width)]",
          "max-h-[var(--radix-select-content-available-height)]",
          className
        )}
        {...rest}
      >
        <SelectScrollButton direction="up" />
        <SelectPrimitive.Viewport className="p-1">
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollButton direction="down" />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export type SelectItemProps = React.ComponentPropsWithoutRef<
  typeof SelectPrimitive.Item
>;

export const SelectItem = forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Item>,
  SelectItemProps
>(function SelectItem({ className, children, ...rest }, ref) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-control py-1 pl-2 pr-6 text-sm text-ink",
        // Radix moves `data-highlighted` with both pointer and keyboard, so
        // one rule covers hover and the active descendant.
        "data-[highlighted]:bg-seal-wash data-[highlighted]:outline-none",
        "data-[disabled]:pointer-events-none data-[disabled]:text-ink-faint",
        className
      )}
      {...rest}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex">
        <Check className="h-3 w-3 text-seal" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
});

export type SelectLabelProps = React.ComponentPropsWithoutRef<
  typeof SelectPrimitive.Label
>;

export const SelectLabel = forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Label>,
  SelectLabelProps
>(function SelectLabel({ className, ...rest }, ref) {
  return (
    <SelectPrimitive.Label
      ref={ref}
      className={cn("px-2 py-1 text-xs text-ink-faint", className)}
      {...rest}
    />
  );
});

export type SelectSeparatorProps = React.ComponentPropsWithoutRef<
  typeof SelectPrimitive.Separator
>;

export const SelectSeparator = forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Separator>,
  SelectSeparatorProps
>(function SelectSeparator({ className, ...rest }, ref) {
  return (
    <SelectPrimitive.Separator
      ref={ref}
      className={cn("my-1 h-px bg-rule", className)}
      {...rest}
    />
  );
});

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof SelectRoot>,
    "children"
  > {
  options: SelectOption[];
  placeholder?: string;
  /** Forwarded to the trigger, so a Field's `htmlFor` resolves to it. */
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/**
 * Options-array select in one call.
 *
 * The parts above remain for a grouped or decorated listbox; this covers the
 * flat case, which is all of Settings. `disabled` on the root is a Radix prop
 * and reaches the trigger through it, so it is not re-declared here.
 */
export function Select({
  options,
  placeholder,
  id,
  className,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...rest
}: SelectProps) {
  return (
    <SelectRoot {...rest}>
      <SelectTrigger
        id={id}
        className={className}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
