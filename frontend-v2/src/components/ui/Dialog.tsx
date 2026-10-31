/**
 * Dialog, wrapping `@radix-ui/react-dialog`.
 *
 * Radix supplies the focus trap, the scroll lock, Escape-to-close and the
 * `aria-modal` wiring; this file only dresses it. `DialogTitle` is not
 * optional in practice — Radix warns at runtime without one and the dialog
 * ends up unlabelled — so `DialogContent` is documented to require it and
 * takes `aria-describedby={undefined}` handling via the description slot.
 */

import { forwardRef } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn, focusRingOnSurface } from "./cn";
import { IconButton } from "./IconButton";
import { X } from "@/components/icons";

export const DialogRoot = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export type DialogContentProps = React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> & {
  /** Set false for a destructive confirm that must be answered explicitly. */
  showClose?: boolean;
};

/** Always render a `DialogTitle` inside: it is the dialog's accessible name. */
export const DialogContent = forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent({ className, children, showClose = true, ...rest }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          // Ink at low alpha, not rgba black: a neutral black scrim turns
          // muddy over the cool paper greys.
          // bg-scrim, never bg-ink: --ink is near-white in dark mode, so an
          // ink scrim veils the app in WHITE there. --scrim does not invert.
          "fixed inset-0 z-50 bg-scrim/60",
          "motion-safe:animate-pop-in"
        )}
      />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-full max-w-measure -translate-x-1/2 -translate-y-1/2",
          "flex max-h-[85vh] flex-col gap-4 overflow-y-auto",
          "rounded-panel border border-rule bg-surface p-6 shadow-dialog",
          // `dialog-in`, not `pop-in`: the keyframe has to carry the
          // centring translate, because an animated `transform` replaces it
          // outright and `both` keeps the replacement after the animation.
          "motion-safe:animate-dialog-in",
          focusRingOnSurface,
          className
        )}
        {...rest}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close asChild>
            <IconButton
              aria-label="Close"
              size="sm"
              className="absolute right-3 top-3"
            >
              <X />
            </IconButton>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

export type DialogTitleProps = React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Title
>;

export const DialogTitle = forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  DialogTitleProps
>(function DialogTitle({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      // pr-8 reserves room for the close button so a long title never runs
      // under it.
      className={cn("pr-8 text-lg font-semibold text-ink", className)}
      {...rest}
    />
  );
});

export type DialogDescriptionProps = React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Description
>;

export const DialogDescription = forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  DialogDescriptionProps
>(function DialogDescription({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn("text-sm text-ink-muted", className)}
      {...rest}
    />
  );
});

/** Action row. Left-aligned, like everything else in the app. */
export function DialogFooter({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-2 pt-2", className)}
      {...rest}
    />
  );
}

export interface DialogProps
  extends Omit<React.ComponentPropsWithoutRef<typeof DialogRoot>, "children"> {
  /** Required: it is the dialog's accessible name. */
  title: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  showClose?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Controlled dialog in one call — title, body, action row.
 *
 * Exists because the common case here is a confirm, and assembling six parts
 * at each call site is how a title (and therefore the accessible name) goes
 * missing. Reach for the parts above only when the layout differs.
 */
export function Dialog({
  title,
  description,
  footer,
  showClose,
  className,
  children,
  ...rest
}: DialogProps) {
  return (
    <DialogRoot {...rest}>
      <DialogContent showClose={showClose} className={className}>
        <div className="flex flex-col gap-2">
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </div>
        {children}
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </DialogRoot>
  );
}
