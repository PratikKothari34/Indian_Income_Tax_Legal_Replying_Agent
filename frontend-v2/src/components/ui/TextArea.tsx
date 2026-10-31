/**
 * Multi-line text input.
 *
 * Shares `inputBase` with TextInput so the two never drift apart on border,
 * focus ring or disabled treatment — the drafting workspace puts them side by
 * side and any difference reads as a bug.
 */

import { forwardRef } from "react";
import { cn } from "./cn";
import { inputBase } from "./TextInput";

export interface TextAreaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  function TextArea({ mono = false, className, rows = 4, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn(
          inputBase,
          // py rather than a fixed height: the control grows with `rows`.
          "resize-y py-2 leading-relaxed",
          mono && "font-mono",
          className
        )}
        {...rest}
      />
    );
  }
);
