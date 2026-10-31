/**
 * Component primitives barrel.
 *
 * App-level code imports from `@/components/ui` and never from a file inside
 * it, so a primitive can be split or renamed without touching call sites.
 * Icons stay at `@/components/icons` — they are not primitives and a barrel
 * re-export of 22 of them would be re-exported noise.
 */

export { cn, focusRing, focusRingOnSurface } from "./cn";

export { Badge } from "./Badge";
export type { BadgeProps, BadgeTone } from "./Badge";

export { Button } from "./Button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./Button";

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogRoot,
  DialogTitle,
  DialogTrigger
} from "./Dialog";
export type {
  DialogContentProps,
  DialogDescriptionProps,
  DialogProps,
  DialogTitleProps
} from "./Dialog";

export { EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";

export { Field } from "./Field";
export type { FieldControlProps, FieldProps } from "./Field";

export { IconButton } from "./IconButton";
export type { IconButtonProps, IconButtonSize } from "./IconButton";

export { Panel, PanelBody, PanelHeader, PanelTitle } from "./Panel";
export type { PanelProps } from "./Panel";

export {
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger
} from "./Popover";
export type { PopoverContentProps } from "./Popover";

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectRoot,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from "./Select";
export type {
  SelectContentProps,
  SelectItemProps,
  SelectLabelProps,
  SelectOption,
  SelectProps,
  SelectSeparatorProps,
  SelectTriggerProps
} from "./Select";

export { SegmentedControl } from "./SegmentedControl";
export type { SegmentedControlProps, SegmentedOption } from "./SegmentedControl";
export { Slider } from "./Slider";
export type { SliderProps } from "./Slider";

export { Spinner } from "./Spinner";
export type { SpinnerProps } from "./Spinner";

export { Switch } from "./Switch";
export type { SwitchProps } from "./Switch";

export { Tabs, TabsContent, TabsList, TabsRoot, TabsTrigger } from "./Tabs";
export type {
  TabItem,
  TabsContentProps,
  TabsListProps,
  TabsProps,
  TabsTriggerProps
} from "./Tabs";

export { TextArea } from "./TextArea";
export type { TextAreaProps } from "./TextArea";

export { TextInput, inputBase } from "./TextInput";
export type { TextInputProps } from "./TextInput";

export { TimeDial } from "./TimeDial";
export type { TimeDialProps } from "./TimeDial";

export { ToastProvider, useToast } from "./Toast";
export type { ToastOptions, ToastTone } from "./Toast";

export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger
} from "./Tooltip";
export type { TooltipContentProps, TooltipProviderProps } from "./Tooltip";
