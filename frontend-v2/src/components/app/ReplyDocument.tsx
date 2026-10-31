/**
 * The signature: a reply rendered as a legal pleading, with every citation
 * pinned into a true left margin at the line it supports.
 *
 * ## How the margin tags are positioned
 *
 * Tags cannot be laid out by the browser: they sit in a separate column from
 * the text they annotate, so nothing in normal flow relates the two. Guessing
 * a line height and multiplying is what makes this kind of feature look broken
 * — the serif body wraps differently at every width, a sentence can wrap
 * across three lines, and `line-height: 1.7` on `Newsreader` with a system
 * fallback is not a number this component may assume.
 *
 * So positions are measured, in four steps:
 *
 * 1. Each sentence is rendered as its own `<span>` with a ref, keyed by span
 *    index. `splitSentences` tiles the reply exactly, so no character is lost.
 * 2. For a citation, the anchor span's **`getClientRects()`** is read — not
 *    `getBoundingClientRect()`. A wrapped sentence's bounding box spans every
 *    line it touches and its top is the *first* line, which is wrong whenever
 *    the citation sits on the second. Each client rect is one line box, so the
 *    rects are walked to find the one containing the citation's own offset,
 *    located with a `Range` over the span's text node.
 * 3. The rect's `top` is converted to an offset inside the article element by
 *    subtracting the article's own `getBoundingClientRect().top`. Both are
 *    viewport-relative, so the difference is scroll-independent and stays
 *    correct inside a scrolling pane.
 * 4. Tags are then de-collided in document order: a tag whose measured top is
 *    closer than one tag-height to the previous tag's bottom is pushed down.
 *    The first tag of a cluster keeps its true line; the rest stack beneath it,
 *    which is how a printed pleading handles two authorities on one line.
 *
 * Re-measured on a `ResizeObserver` of the article (width change rewraps every
 * line) and on font load, because a late-arriving `Newsreader` changes every
 * line box after the first measurement.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Badge, Button, Tooltip, cn } from "@/components/ui";
import { Copy, Folder } from "@/components/icons";
import {
  kindLabel,
  mapCitationsToSpans,
  parseCitations,
  splitSentences,
  verifyCitations,
  type Citation
} from "@/lib/citations";
import type { RagDocument } from "@/types/api";

export type ReplyDocumentProps = {
  reply: string;
  modelUsed: string;
  outputFile: string | null;
  /** Indexed corpus, for verification. Empty while it is still loading. */
  corpus: readonly RagDocument[];
  onCitationClick?: (citation: Citation) => void;
  onCopy?: () => void;
  onOpenOutputFolder?: () => void;
  /** Write this reply to a `.docx`. Does not re-run the model. */
  onSave?: () => void;
  /** True while that write is in flight. */
  saving?: boolean;
  className?: string;
};

type TagPosition = {
  citation: Citation;
  /** Final top offset inside the article, after de-collision. */
  top: number;
  /** The measured top before de-collision, for the leader line. */
  anchorTop: number;
};

/** Tag box height plus breathing room, in px. Drives de-collision spacing. */
const TAG_SLOT = 26;

/**
 * Below this article width the margin collapses and the citations render as a
 * list under the reply. Must agree with the `max-width: 720px` query on
 * `--margin-width` in `styles/tokens.css`: if this is larger, tags render as a
 * list while the CSS still reserves the gutter, leaving a blank column.
 *
 * Measured on the article, not the viewport, because the reply shares its row
 * with the notice pane above 1100px -- a 1400px window can still give the
 * reply 450px, and the viewport would report it as wide.
 */
const MARGIN_COLLAPSE_PX = 720;

/**
 * The client rect of a character offset inside a span.
 *
 * A `Range` collapsed over the citation's first character gives the line box
 * it actually sits on, which is the whole point — a sentence that wraps has
 * several line boxes and only one of them is the right place for the tag.
 */
function rectForOffsetInSpan(
  span: HTMLElement,
  offsetInSpan: number
): DOMRect | null {
  const textNode = span.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    return span.getClientRects()[0] ?? null;
  }
  const length = textNode.textContent?.length ?? 0;
  if (length === 0) {
    return span.getClientRects()[0] ?? null;
  }
  const clamped = Math.max(0, Math.min(offsetInSpan, length - 1));

  try {
    const range = document.createRange();
    range.setStart(textNode, clamped);
    range.setEnd(textNode, Math.min(clamped + 1, length));
    const rects = range.getClientRects();
    // A range over one character can still yield an empty list when that
    // character is collapsed whitespace at a line break; the span's own first
    // rect is the honest fallback.
    const rect = rects[0];
    range.detach();
    return rect ?? span.getClientRects()[0] ?? null;
  } catch {
    return span.getClientRects()[0] ?? null;
  }
}

export function ReplyDocument({
  reply,
  modelUsed,
  outputFile,
  corpus,
  onCitationClick,
  onCopy,
  onOpenOutputFolder,
  onSave,
  saving = false,
  className
}: ReplyDocumentProps) {
  const articleRef = useRef<HTMLElement | null>(null);
  const spanRefs = useRef<Map<number, HTMLElement>>(new Map());
  const [positions, setPositions] = useState<TagPosition[]>([]);
  const [hoveredCitationId, setHoveredCitationId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const spans = useMemo(() => splitSentences(reply), [reply]);

  // Parse once per reply, verify separately: the corpus list arrives on its
  // own schedule and must not force a re-parse of a 30 KB document.
  const parsed = useMemo(() => parseCitations(reply), [reply]);
  const citations = useMemo(() => verifyCitations(parsed, corpus), [parsed, corpus]);

  const { anchorBySpan, spansByCitation } = useMemo(
    () => mapCitationsToSpans(citations, spans),
    [citations, spans]
  );

  const registerSpan = useCallback((index: number, element: HTMLElement | null) => {
    if (element) {
      spanRefs.current.set(index, element);
    } else {
      spanRefs.current.delete(index);
    }
  }, []);

  // Driven by the same ResizeObserver that triggers re-measurement, so the
  // collapse and the measurement can never disagree about the width.
  const [marginCollapsed, setMarginCollapsed] = useState(false);

  /** Measure every tag's true line, then de-collide. */
  const measure = useCallback(() => {
    const article = articleRef.current;
    if (!article) {
      return;
    }
    // Collapsed: the tags are in normal flow under the reply, so there is
    // nothing to pin and measuring would fight the browser's own layout.
    if (article.clientWidth > 0 && article.clientWidth < MARGIN_COLLAPSE_PX) {
      setMarginCollapsed(true);
      setPositions((previous) => (previous.length === 0 ? previous : []));
      return;
    }
    setMarginCollapsed(false);
    const articleTop = article.getBoundingClientRect().top;

    const measured: { citation: Citation; anchorTop: number }[] = [];
    for (const [spanIndex, spanCitations] of anchorBySpan) {
      const element = spanRefs.current.get(spanIndex);
      const span = spans[spanIndex];
      if (!element || !span) {
        continue;
      }
      for (const citation of spanCitations) {
        const anchor = citation.occurrences[0];
        if (!anchor) {
          continue;
        }
        const rect = rectForOffsetInSpan(element, anchor.start - span.start);
        if (!rect) {
          continue;
        }
        measured.push({ citation, anchorTop: rect.top - articleTop });
      }
    }

    measured.sort((a, b) => a.anchorTop - b.anchorTop);

    // De-collision: keep the first tag of a cluster on its real line and
    // stack the rest below, so two authorities on one line both stay readable
    // and neither drifts far from the text it supports.
    const resolved: TagPosition[] = [];
    let floor = Number.NEGATIVE_INFINITY;
    for (const entry of measured) {
      const top = Math.max(entry.anchorTop, floor);
      resolved.push({ citation: entry.citation, top, anchorTop: entry.anchorTop });
      floor = top + TAG_SLOT;
    }

    setPositions((previous) => {
      // Avoid a render when nothing moved: the ResizeObserver fires on any
      // height change, including the one this very update would cause.
      if (previous.length === resolved.length) {
        const same = previous.every((item, index) => {
          const next = resolved[index];
          return (
            next !== undefined &&
            next.citation.id === item.citation.id &&
            Math.abs(next.top - item.top) < 0.5
          );
        });
        if (same) {
          return previous;
        }
      }
      return resolved;
    });
  }, [anchorBySpan, spans]);

  // Layout effect, not effect: measuring after paint but before the browser
  // yields keeps the tags from appearing at 0 for one frame.
  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const article = articleRef.current;
    if (!article || typeof ResizeObserver === "undefined") {
      return;
    }
    // A width change rewraps every line, so every tag's line is now wrong.
    const observer = new ResizeObserver(() => measure());
    observer.observe(article);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => {
    // A late webfont changes every line box after the first measurement. Fonts
    // are local per the design constraints, but `document.fonts` still settles
    // asynchronously on a cold start.
    const fonts = document.fonts;
    if (!fonts) {
      return;
    }
    let cancelled = false;
    void fonts.ready.then(() => {
      if (!cancelled) {
        measure();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [measure]);

  const highlightedSpans = useMemo(() => {
    if (!hoveredCitationId) {
      return new Set<number>();
    }
    return new Set(spansByCitation.get(hoveredCitationId) ?? []);
  }, [hoveredCitationId, spansByCitation]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(reply);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      onCopy?.();
    } catch {
      // Clipboard can be refused without a user gesture or in a locked-down
      // webview. The reply is selectable, so this is not worth an error panel.
      setCopied(false);
    }
  }, [onCopy, reply]);

  const unverifiedCount = citations.filter((c) => c.verified === false).length;

  return (
    <div className={cn("flex min-h-0 flex-col bg-surface", className)}>
      <header className="flex flex-wrap items-center gap-3 border-b border-rule px-4 py-3">
        <h2 className="text-base font-medium text-ink">Draft</h2>
        {/* Mono is right here -- a model name is an identifier. The label is
            spoken rather than left to a title attribute, which never reaches
            a keyboard or touch user. */}
        <span className="font-mono text-xs text-ink-faint">
          <span className="sr-only">Model used: </span>
          {modelUsed}
        </span>
        {unverifiedCount > 0 ? (
          <Badge tone="amber">
            {unverifiedCount === 1
              ? "1 citation not in your corpus"
              : `${unverifiedCount} citations not in your corpus`}
          </Badge>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            aria-label="Copy the draft to the clipboard"
          >
            <Copy aria-hidden="true" />
            {copied ? "Copied" : "Copy"}
          </Button>
          {outputFile ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenOutputFolder}
              aria-label="Open the folder holding the saved file"
            >
              <Folder aria-hidden="true" />
              Open folder
            </Button>
          ) : onSave ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onSave}
              disabled={saving}
            >
              {saving ? "Saving" : "Save as .docx"}
            </Button>
          ) : null}
        </div>
      </header>

      {/* The scroll container. The article inside it is the measurement frame,
          so tag offsets are independent of how far this is scrolled. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <article
          ref={articleRef}
          className="relative px-4 py-6"
          style={
            marginCollapsed
              ? undefined
              : { paddingLeft: "calc(var(--margin-width) + 1rem)" }
          }
        >
          {/* The pleading rule. Decorative, so it is hidden from the a11y tree
              — the tags themselves carry the meaning. */}
          {!marginCollapsed && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute bottom-0 top-0 w-px bg-rule"
              style={{ left: "var(--margin-width)" }}
            />
          )}

          {/* Margin tags. A list, because that is what it is: the authorities
              this draft relies on, in the order it relies on them. Pinned to
              their line when there is a margin to pin them into; below the
              reply when there is not. */}
          {!marginCollapsed && (
            <ul
              className="pointer-events-none absolute bottom-0 left-0 top-0 m-0 list-none p-0"
              style={{ width: "var(--margin-width)" }}
              aria-label="Citations in this draft"
            >
              {positions.map(({ citation, top }) => (
                <li
                  key={citation.id}
                  className="pointer-events-auto absolute right-3"
                  style={{ top: `${top}px` }}
                >
                  <MarginTag
                    citation={citation}
                    animate
                    isActive={hoveredCitationId === citation.id}
                    onHoverChange={(hovered) =>
                      setHoveredCitationId(hovered ? citation.id : null)
                    }
                    onClick={() => onCitationClick?.(citation)}
                  />
                </li>
              ))}
            </ul>
          )}

          <div className="max-w-measure font-serif text-base text-ink" style={{ lineHeight: 1.7 }}>
            {spans.map((span, index) =>
              span.isBreak ? (
                // A real paragraph break in the reply. Rendered as spacing
                // rather than a <p> so the span tiling stays one flat list and
                // measurement indices keep matching the parser's.
                <span
                  key={`break-${span.start}`}
                  aria-hidden="true"
                  className="block h-4"
                />
              ) : (
                <span
                  key={`span-${span.start}`}
                  ref={(element) => registerSpan(index, element)}
                  className={cn(
                    "transition-colors duration-120 ease-ledger",
                    highlightedSpans.has(index) ? "bg-seal-wash" : "bg-transparent"
                  )}
                >
                  {span.text}
                </span>
              )
            )}
          </div>

          {/* Collapsed margin: the authorities still have to be reachable, so
              they follow the reply in the order it relies on them. Source
              order here matches the pinned layout's, so a screen reader hears
              the same sequence either way. */}
          {marginCollapsed && citations.length > 0 && (
            <ul
              className="mt-6 flex list-none flex-wrap gap-2 border-t border-rule p-0 pt-4"
              aria-label="Citations in this draft"
            >
              {citations.map((citation) => (
                <li key={citation.id}>
                  <MarginTag
                    citation={citation}
                    animate={false}
                    isActive={hoveredCitationId === citation.id}
                    onHoverChange={(hovered) =>
                      setHoveredCitationId(hovered ? citation.id : null)
                    }
                    onClick={() => onCitationClick?.(citation)}
                  />
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>
    </div>
  );
}

type MarginTagProps = {
  citation: Citation;
  animate: boolean;
  isActive: boolean;
  onHoverChange: (hovered: boolean) => void;
  onClick: () => void;
};

function MarginTag({
  citation,
  animate,
  isActive,
  onHoverChange,
  onClick
}: MarginTagProps) {
  const unverified = citation.verified === false;
  const label = kindLabel(citation.kind);

  // The accessible name carries what the visual tag cannot: which kind of
  // authority this is, and whether it was found in the corpus.
  const accessibleName = unverified
    ? `${label} ${citation.raw}, unverified — not in your corpus`
    : citation.verified === true
      ? `${label} ${citation.raw}, found in your corpus`
      : `${label} ${citation.raw}`;

  const tooltip = unverified
    ? "Not in your corpus. Sync, or check it by hand."
    : citation.verified === true
      ? citation.matchedDocument
        ? `In your corpus: ${citation.matchedDocument}`
        : "In your corpus"
      : "Checking your corpus";

  return (
    <Tooltip content={tooltip}>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => onHoverChange(true)}
        onMouseLeave={() => onHoverChange(false)}
        onFocus={() => onHoverChange(true)}
        onBlur={() => onHoverChange(false)}
        aria-label={accessibleName}
        className={cn(
          "block max-w-full truncate rounded-control border px-2 py-1 text-left font-mono text-xs",
          "transition-colors duration-120 ease-ledger",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-seal focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
          unverified
            ? "border-amber text-amber hover:bg-amber-wash"
            : "border-rule text-seal hover:border-seal hover:bg-seal-wash",
          isActive && (unverified ? "bg-amber-wash" : "bg-seal-wash"),
          // The one piece of choreography in the app: a citation landing in
          // the margin. `motion-safe:` keeps the suppression in CSS, so it
          // follows the OS setting live -- a value read once into a ref at
          // mount would miss a change made mid-session.
          animate && "motion-safe:animate-tag-in"
        )}
      >
        {citation.raw}
        {unverified ? (
          <span className="mt-px block font-sans text-xs text-amber">unverified</span>
        ) : null}
      </button>
    </Tooltip>
  );
}
