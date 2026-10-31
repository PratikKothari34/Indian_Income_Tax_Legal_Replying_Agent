/**
 * Tabs, wrapping `@radix-ui/react-tabs`.
 *
 * The active tab is marked by a 2px seal underline sitting on the list's own
 * bottom rule, not by a filled pill. Panels in this app are separated by
 * rules, and a pill would be the only floating chrome on the surface.
 */

import { forwardRef } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn, focusRingOnSurface } from "./cn";

export const TabsRoot = TabsPrimitive.Root;

export type TabsListProps = React.ComponentPropsWithoutRef<
  typeof TabsPrimitive.List
>;

export const TabsList = forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  TabsListProps
>(function TabsList({ className, ...rest }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        "flex items-stretch gap-4 border-b border-rule",
        className
      )}
      {...rest}
    />
  );
});

export type TabsTriggerProps = React.ComponentPropsWithoutRef<
  typeof TabsPrimitive.Trigger
>;

export const TabsTrigger = forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  TabsTriggerProps
>(function TabsTrigger({ className, ...rest }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        // -mb-px pulls the underline over the list's border so the two read as
        // one line rather than stacking into 3px.
        "-mb-px whitespace-nowrap border-b-2 border-transparent px-1 pb-2 pt-1",
        "text-sm font-medium text-ink-muted transition-colors duration-120 ease-ledger",
        "hover:text-ink",
        "data-[state=active]:border-seal data-[state=active]:text-ink",
        "disabled:pointer-events-none disabled:text-ink-faint",
        // Offset would clip against the list edge; inset keeps it visible.
        focusRingOnSurface,
        "focus-visible:ring-offset-0",
        className
      )}
      {...rest}
    />
  );
});

export type TabsContentProps = React.ComponentPropsWithoutRef<
  typeof TabsPrimitive.Content
>;

export const TabsContent = forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  TabsContentProps
>(function TabsContent({ className, ...rest }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn("pt-4", focusRingOnSurface, className)}
      {...rest}
    />
  );
});

export interface TabItem {
  value: string;
  label: string;
  content: React.ReactNode;
  disabled?: boolean;
}

export interface TabsProps
  extends Omit<React.ComponentPropsWithoutRef<typeof TabsRoot>, "children"> {
  items: TabItem[];
  /** Class for the list strip; the root takes `className` as usual. */
  listClassName?: string;
}

/**
 * Items-array tabs in one call.
 *
 * Keeps each tab's trigger and panel declared together, which is what stops a
 * `value` on one side drifting from the other and silently rendering a blank
 * panel. Use the parts above when a trigger needs its own content.
 */
export function Tabs({ items, listClassName, ...rest }: TabsProps) {
  return (
    <TabsRoot {...rest}>
      <TabsList className={listClassName}>
        {items.map((item) => (
          <TabsTrigger
            key={item.value}
            value={item.value}
            disabled={item.disabled}
          >
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {items.map((item) => (
        <TabsContent key={item.value} value={item.value}>
          {item.content}
        </TabsContent>
      ))}
    </TabsRoot>
  );
}
