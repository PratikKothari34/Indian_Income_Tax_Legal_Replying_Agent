/**
 * Inline SVG icon set.
 *
 * Inline and local because the contract forbids any network call at runtime —
 * no icon font, no sprite fetch, no remote SVG. Each icon is a 24x24 stroked
 * outline on `currentColor`, so colour comes from the text colour of whatever
 * contains it and dark mode needs no second asset.
 *
 * `focusable="false"` matters for the IE/WebView lineage of SVG handling and
 * costs nothing; `aria-hidden` is the default because an icon next to a label
 * is decorative. An icon used *as* the whole control gets its name from the
 * control (see IconButton), never from the glyph.
 */

import type { SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

/**
 * Shared geometry and stroke setup. Size via `className` (e.g. `h-4 w-4`).
 *
 * Its own props type, not `IconProps`: that one omits `children` so a caller
 * cannot put arbitrary content inside an icon, but the icons here are defined
 * BY their children, and a filled icon also has to override `fill`/`stroke`.
 */
function Svg({ className, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden="true"
      className={className}
      {...rest}
    />
  );
}

export function Upload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </Svg>
  );
}

export function FileText(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </Svg>
  );
}

/** Drafting — a pen on the page, matching the "Draft reply" action. */
export function Draft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
      <path d="m14.5 5.5 3 3" />
    </Svg>
  );
}

/** Corpus — stacked statutory volumes. */
export function Corpus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H9v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
      <path d="M9 4h5.5A1.5 1.5 0 0 1 16 5.5v13A1.5 1.5 0 0 1 14.5 20H9" />
      <path d="m17.5 5.4 1.9 13.1" />
      <path d="M6.5 8.5h.5" />
    </Svg>
  );
}

/**
 * A cog: a rim, a hub, and eight teeth.
 *
 * It was a circle with six spokes radiating outward, which is a sun -- and
 * it sat in the rail directly beside the sun/moon theme toggle, where it
 * read as a second theme control rather than as settings.
 */
export function Settings(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="7.4" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12.0 4.6L12.0 2.2M17.2 6.8L18.9 5.1M19.4 12.0L21.8 12.0M17.2 17.2L18.9 18.9M12.0 19.4L12.0 21.8M6.8 17.2L5.1 18.9M4.6 12.0L2.2 12.0M6.8 6.8L5.1 5.1" />
    </Svg>
  );
}

export function Check(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Svg>
  );
}

export function Alert(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.3 4.3 2.8 17.2A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4" />
      <path d="M12 16.8h.01" />
    </Svg>
  );
}

export function Info(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.8h.01" />
    </Svg>
  );
}

export function X(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

export function ChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 9 7 7 7-7" />
    </Svg>
  );
}

export function Search(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" />
    </Svg>
  );
}

export function Refresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 11a8 8 0 0 0-13.7-5.3L3 9" />
      <path d="M3 4.5V9h4.5" />
      <path d="M4 13a8 8 0 0 0 13.7 5.3L21 15" />
      <path d="M21 19.5V15h-4.5" />
    </Svg>
  );
}

export function Trash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l.8 12a2 2 0 0 0 2 1.9h6.4a2 2 0 0 0 2-1.9L18 7" />
      <path d="M10.5 11v6M13.5 11v6" />
    </Svg>
  );
}

export function Folder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z" />
    </Svg>
  );
}

export function Copy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M15 6.5V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15h1" />
    </Svg>
  );
}

/**
 * The Windows mark: four panes in perspective, as the modern logo draws them.
 *
 * `WindowMaximize` stood here first and was wrong -- it is a caption glyph, a
 * plain square, and beside three other category icons it read as an empty
 * checkbox rather than as "the operating system".
 *
 * Filled, not stroked: at 16px four stroked panes with a 1.5 stroke collapse
 * into a grey smudge, because the gaps between them are thinner than the
 * strokes around them. `fill="currentColor"` with `stroke="none"` keeps the
 * mark legible and still inherits its colour from the text.
 */
export function Windows(props: IconProps) {
  return (
    <Svg fill="currentColor" stroke="none" {...props}>
      <path d="M3 5.9 10.6 4.8v6.7H3z" />
      <path d="M11.6 4.65 21 3.3v8.2h-9.4z" />
      <path d="M3 12.5h7.6v6.7L3 18.1z" />
      <path d="M11.6 12.5H21v8.2l-9.4-1.35z" />
    </Svg>
  );
}

export function Clock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3.2 2" />
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// Window controls
// ---------------------------------------------------------------------------

/**
 * The caption glyphs do not use `Svg`.
 *
 * Every other icon here is a 24x24 round-capped 1.5 stroke, which is right for
 * an interface mark and wrong for a window control: these are hairline
 * rectangles that have to sit on the pixel grid, and a round cap on a 10px
 * square reads as a blur. Windows draws them as 10x10 butt-capped 1px marks,
 * so these match that geometry rather than the icon set's.
 */
function Caption({ className, ...rest }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 10 10"
      width={10}
      height={10}
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      focusable="false"
      aria-hidden="true"
      className={className}
      {...rest}
    />
  );
}

export function WindowMinimize(props: IconProps) {
  return (
    <Caption {...props}>
      <path d="M0 5.5h10" />
    </Caption>
  );
}

export function WindowMaximize(props: IconProps) {
  return (
    <Caption {...props}>
      <rect x="0.5" y="0.5" width="9" height="9" />
    </Caption>
  );
}

/** The restore mark: the front pane with the one behind it showing at two edges. */
export function WindowRestore(props: IconProps) {
  return (
    <Caption {...props}>
      <rect x="0.5" y="2.5" width="7" height="7" />
      <path d="M2.5 2.5v-2h7v7h-2" />
    </Caption>
  );
}

export function WindowClose(props: IconProps) {
  return (
    <Caption {...props}>
      <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
    </Caption>
  );
}
