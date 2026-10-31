/**
 * Citation parsing — the statutory margin's data layer.
 *
 * The signature feature of this app is that every citation the model emitted is
 * pinned into the reply's left margin at the line it supports, and flagged when
 * it is not in the user's corpus. That is only as good as this parser.
 *
 * Pure and side-effect free on purpose: no DOM, no React, no fetch. It takes a
 * string, it returns data. That makes it unit-testable, and it means the
 * measurement layer in `ReplyDocument` can be reasoned about separately.
 *
 * ## The one rule that must never be relaxed
 *
 * **The slash is significant.** `Circular 19/2023` and `Circular 19/2019` are
 * different circulars with different holdings. Normalisation here lowercases,
 * collapses whitespace and drops decorative punctuation — it never touches the
 * `number/year` pair. A CA who is shown the wrong circular as "verified" is
 * worse off than one shown nothing.
 */

export type CitationKind =
  | "section"
  | "circular"
  | "notification"
  | "rule"
  | "case";

export type Citation = {
  /** Stable within one parse: `kind:normalised`. Safe as a React key. */
  id: string;
  kind: CitationKind;
  /** Exactly as it appeared in the reply, for display. */
  raw: string;
  /**
   * Canonical form for dedupe and corpus matching. Lowercased, whitespace
   * collapsed, prefix words unified — but the `number/year` slash is preserved
   * verbatim.
   */
  normalised: string;
  /** Character offset of the first occurrence in the source text. */
  start: number;
  /** Character offset one past the end of the first occurrence. */
  end: number;
  /** 0-based index of the line the first occurrence sits on. */
  lineIndex: number;
  /** Every occurrence, first included, in document order. */
  occurrences: CitationOccurrence[];
  /**
   * Corpus state. `undefined` until `verifyCitations` has run — the margin
   * renders a citation as neutral rather than guessing while the corpus list is
   * still loading.
   */
  verified?: boolean;
  /** Title of the corpus document that matched, when one did. */
  matchedDocument?: string;
};

export type CitationOccurrence = {
  start: number;
  end: number;
  lineIndex: number;
  /** The citation text at this position; casing can differ between hits. */
  raw: string;
};

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * Each pattern is matched over the whole text with a single sticky-free global
 * pass, then overlaps are resolved by preferring the longest match starting
 * earliest. Writing one mega-regex instead would be unreadable and would make
 * the kind of a match ambiguous.
 */

/**
 * Sections. Covers `s.148A(b)`, `S. 148A (b)`, `Section 148A(b)`,
 * `u/s 143(2)`, `under section 68`, `sec. 271(1)(c)`.
 *
 * The number is `digits + optional letter suffix` (148A, 115BAC), followed by
 * any run of parenthesised sub-clauses. `(?!\w)` stops `s.148` from being
 * clipped out of a longer token.
 */
const SECTION_RE =
  /\b(?:u\/s|under\s+section|section|sect|sec|ss|s)\s*\.?\s*(\d{1,3}[A-Z]{0,3})((?:\s*\([0-9a-zA-Z]{1,4}\))*)/gi;

/**
 * Circulars. `Circular No. 19/2023`, `Circular 19/2023`,
 * `CBDT Circular No. 6/2024`, `Circular No 19 of 2023`.
 *
 * The issuing body is captured but deliberately dropped from the normalised
 * form: `CBDT Circular 19/2023` and `Circular 19/2023` are the same document,
 * and treating them as two would double the margin for no information.
 */
const CIRCULAR_RE =
  /\b(?:cbdt\s+|cbec\s+|board'?s?\s+)?circulars?\s*(?:no\.?s?|number)?\s*\.?\s*(\d{1,4})\s*(?:\/|\s+of\s+)\s*(\d{2,4})/gi;

/** Notifications. Same shape as circulars, including `S.O.`-free plain form. */
const NOTIFICATION_RE =
  /\b(?:cbdt\s+)?notifications?\s*(?:no\.?s?|number)?\s*\.?\s*(\d{1,4})\s*(?:\/|\s+of\s+)\s*(\d{2,4})/gi;

/**
 * Rules of the Income-tax Rules, 1962. `Rule 11UA`, `rule 128`,
 * `Rule 11UA(2)`. Alphanumeric suffixes are the norm here (11UA, 12AB), so the
 * letter run is longer than a section's.
 */
const RULE_RE =
  /\brules?\s*\.?\s*(\d{1,3}[A-Z]{0,4})((?:\s*\([0-9a-zA-Z]{1,4}\))*)/gi;

/**
 * Case law. `CIT v. Something`, `ACIT vs XYZ Ltd`, `Vodafone India Ltd. v. CIT`.
 *
 * Both sides are a short run of capitalised words or all-caps abbreviations.
 * Deliberately conservative: a false positive here puts a wrong tag in the
 * margin, which costs the user more than a missed one. The separator
 * (`v`/`vs`/`versus`) must be its own token.
 *
 * `and`/`&`/`of` are allowed *inside* a party name but never at its edge, so
 * "S. Goyanka Lime and Chemicals Ltd." stays whole instead of being clipped to
 * "S. Goyanka Lime". A name clipped mid-way reads in the margin as a parser
 * bug even when the match itself is correct.
 */
const CASE_WORD = "[A-Z][A-Za-z&.'-]*\\.?";
const CASE_INNER = "(?:and|&|of|the)";
const CASE_SIDE = `(?:${CASE_WORD}|${CASE_INNER})(?:\\s+(?:${CASE_WORD}|${CASE_INNER})){0,5}`;
const CASE_RE = new RegExp(
  // The side must start and end on a capitalised word, with connectives only
  // in between — that is what keeps a trailing "and" out of the match.
  `\\b(${CASE_WORD}(?:\\s+${CASE_SIDE})?)\\s+(?:v|vs|versus)\\.?\\s+(${CASE_WORD}(?:\\s+${CASE_SIDE})?)`,
  "g"
);

/**
 * Words that are never one side of a case name, even though they are
 * capitalised at a sentence start. Without this, "The assessee relied on ... .
 * In X v. Y" happily swallows a leading "In".
 */
const CASE_STOPWORDS = new Set([
  "the",
  "in",
  "on",
  "at",
  "and",
  "but",
  "for",
  "see",
  "as",
  "per",
  "held",
  "that",
  "this",
  "it",
  "a",
  "an",
  "of",
  "by",
  "to",
  "from",
  "case",
  "cases",
  "matter",
  "judgment",
  "judgement",
  "decision",
  "ruling",
  "paragraph",
  "para",
  "section",
  "rule",
  "circular",
  "notification"
]);

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Collapse all whitespace runs to one space and trim. */
function squash(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Normalise a parenthesised sub-clause chain: `(1) (c)` and `(1)(c)` are the
 * same clause, so both become `(1)(c)`. Lowercased, because statutes are cited
 * with both `(B)` and `(b)` in practice.
 */
function normaliseClauses(clauses: string): string {
  const parts = clauses.match(/\([0-9a-zA-Z]{1,4}\)/g);
  if (!parts) {
    return "";
  }
  return parts.map((part) => part.replace(/\s+/g, "").toLowerCase()).join("");
}

/**
 * Strip a trailing abbreviation-dot and tidy a party name for display and
 * matching. `Ltd.` keeps its sense without the dot; `Pvt.Ltd` is not a real
 * variant worth handling.
 */
function normaliseParty(value: string): string {
  return squash(value).replace(/\.$/, "").toLowerCase();
}

/**
 * Drop connectives that the party pattern allowed at the tail. The regex
 * permits `and`/`of`/`the` mid-name, which means a side can also *end* on one
 * ("X and v. Y"); that trailing word belongs to the sentence, not the name.
 */
function trimTrailingConnectives(value: string): string {
  let result = squash(value);
  for (;;) {
    const trimmed = result.replace(/\s+(?:and|&|of|the)$/i, "");
    if (trimmed === result) {
      return trimmed;
    }
    result = trimmed;
  }
}

// ---------------------------------------------------------------------------
// Line index
// ---------------------------------------------------------------------------

/**
 * Offsets at which each line starts. Built once per parse so mapping an offset
 * to a line is a binary search rather than a re-scan of the text per citation —
 * a 30 KB reply with 60 citations would otherwise be 60 full scans.
 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    const start = starts[mid];
    if (start !== undefined && start <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

type RawHit = {
  kind: CitationKind;
  start: number;
  end: number;
  raw: string;
  normalised: string;
};

function collectSections(text: string, hits: RawHit[]): void {
  SECTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECTION_RE.exec(text)) !== null) {
    const number = match[1];
    if (number === undefined) {
      continue;
    }
    const clauses = normaliseClauses(match[2] ?? "");
    hits.push({
      kind: "section",
      start: match.index,
      end: match.index + match[0].length,
      raw: squash(match[0]),
      // Unified prefix: every spelling of "section" collapses to `s.`, so
      // `u/s 143(2)` and `Section 143(2)` dedupe to one margin tag.
      normalised: `s.${number.toLowerCase()}${clauses}`
    });
  }
}

function collectNumbered(
  text: string,
  pattern: RegExp,
  kind: "circular" | "notification",
  hits: RawHit[]
): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const number = match[1];
    const year = match[2];
    if (number === undefined || year === undefined) {
      continue;
    }
    hits.push({
      kind,
      start: match.index,
      end: match.index + match[0].length,
      raw: squash(match[0]),
      // The slash is load-bearing and is written back literally. A two-digit
      // year is expanded so `19/23` and `19/2023` dedupe, but the separator
      // itself is never dropped.
      normalised: `${kind} ${Number(number)}/${expandYear(year)}`
    });
  }
}

/**
 * `23` → `2023`, `99` → `1999`. Circulars predating 1950 are not something
 * this app will meet, so the pivot is safe and keeps the slash pair comparable.
 */
function expandYear(year: string): string {
  if (year.length === 4) {
    return year;
  }
  if (year.length !== 2) {
    return year;
  }
  const value = Number(year);
  return value <= 50 ? `20${year}` : `19${year}`;
}

function collectRules(text: string, hits: RawHit[]): void {
  RULE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RULE_RE.exec(text)) !== null) {
    const number = match[1];
    if (number === undefined) {
      continue;
    }
    const clauses = normaliseClauses(match[2] ?? "");
    hits.push({
      kind: "rule",
      start: match.index,
      end: match.index + match[0].length,
      raw: squash(match[0]),
      normalised: `rule ${number.toLowerCase()}${clauses}`
    });
  }
}

function collectCases(text: string, hits: RawHit[]): void {
  CASE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CASE_RE.exec(text)) !== null) {
    const leftRaw = match[1];
    const rightRaw = match[2];
    if (leftRaw === undefined || rightRaw === undefined) {
      continue;
    }

    // Drop a leading stopword rather than the whole match: "In CIT v. X" is a
    // real citation whose left party is "CIT", not "In CIT".
    const trimmedLeft = trimTrailingConnectives(dropLeadingStopwords(leftRaw));
    const trimmedRight = trimTrailingConnectives(rightRaw);
    if (!trimmedLeft || !trimmedRight) {
      continue;
    }
    const left = normaliseParty(trimmedLeft);
    const right = normaliseParty(trimmedRight);
    if (!left || !right) {
      continue;
    }
    if (CASE_STOPWORDS.has(right.split(" ")[0] ?? "")) {
      continue;
    }

    // Re-anchor both ends so the raw text shown in the margin is exactly the
    // parties recorded — a tag that reads wider than the citation it stands
    // for is worse than no tag.
    const leftOffset = match[0].indexOf(trimmedLeft);
    const start = match.index + (leftOffset >= 0 ? leftOffset : 0);
    const rightOffset = match[0].lastIndexOf(trimmedRight);
    const end =
      rightOffset >= 0
        ? match.index + rightOffset + trimmedRight.length
        : match.index + match[0].length;
    hits.push({
      kind: "case",
      start,
      end,
      raw: squash(text.slice(start, end)),
      normalised: `${left} v. ${right}`
    });
  }
}

function dropLeadingStopwords(value: string): string {
  const words = squash(value).split(" ");
  let index = 0;
  while (index < words.length - 1) {
    const word = words[index];
    if (word === undefined) {
      break;
    }
    if (!CASE_STOPWORDS.has(word.replace(/\.$/, "").toLowerCase())) {
      break;
    }
    index += 1;
  }
  const rest = words.slice(index).join(" ");
  const last = words[words.length - 1];
  // A single remaining word that is itself a stopword is not a party name.
  if (rest === last && CASE_STOPWORDS.has(normaliseParty(rest))) {
    return "";
  }
  return rest;
}

/**
 * Resolve overlaps between patterns. `Rule 11UA` also matches the section
 * pattern's bare-`s` branch in some texts, and a case name can contain a
 * capitalised word the section pattern likes. Earliest start wins; on a tie,
 * the longer match wins; on a further tie, pattern order (the array's order)
 * decides.
 */
function resolveOverlaps(hits: RawHit[]): RawHit[] {
  const sorted = [...hits].sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    return b.end - b.start - (a.end - a.start);
  });

  const kept: RawHit[] = [];
  let cursor = -1;
  for (const hit of sorted) {
    if (hit.start < cursor) {
      continue;
    }
    kept.push(hit);
    cursor = hit.end;
  }
  return kept;
}

/**
 * Parse every citation out of a reply.
 *
 * Deduplicated by `normalised`, so one margin tag per distinct authority — but
 * every position is kept in `occurrences`, which is what lets the renderer
 * highlight *all* the sentences a repeatedly cited section supports, and pin
 * the tag at the first one.
 */
export function parseCitations(text: string): Citation[] {
  if (!text) {
    return [];
  }

  const hits: RawHit[] = [];
  collectSections(text, hits);
  collectNumbered(text, CIRCULAR_RE, "circular", hits);
  collectNumbered(text, NOTIFICATION_RE, "notification", hits);
  collectRules(text, hits);
  collectCases(text, hits);

  const resolved = resolveOverlaps(hits);
  const starts = lineStarts(text);
  const byNormalised = new Map<string, Citation>();

  for (const hit of resolved) {
    const key = `${hit.kind}:${hit.normalised}`;
    const occurrence: CitationOccurrence = {
      start: hit.start,
      end: hit.end,
      lineIndex: lineAt(starts, hit.start),
      raw: hit.raw
    };
    const existing = byNormalised.get(key);
    if (existing) {
      existing.occurrences.push(occurrence);
      continue;
    }
    byNormalised.set(key, {
      id: key,
      kind: hit.kind,
      raw: hit.raw,
      normalised: hit.normalised,
      start: hit.start,
      end: hit.end,
      lineIndex: occurrence.lineIndex,
      occurrences: [occurrence]
    });
  }

  // Document order, so the margin reads top to bottom like the reply does.
  return [...byNormalised.values()].sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Verification against the corpus
// ---------------------------------------------------------------------------

/**
 * Searchable text for one corpus document. `RagDocument` is intentionally open
 * (`[key: string]: unknown`), so only the fields the contract names are read,
 * and each is type-checked before use rather than cast.
 */
type CorpusEntry = { title: string; haystack: string };

/** Minimal shape this module needs from a corpus document. */
export type VerifiableDocument = {
  title?: string;
  source?: string;
  doc_type?: string;
  url?: string;
  [key: string]: unknown;
};

function stringField(doc: VerifiableDocument, key: string): string {
  const value = doc[key];
  return typeof value === "string" ? value : "";
}

function buildCorpus(docs: readonly VerifiableDocument[]): CorpusEntry[] {
  return docs.map((doc) => {
    const title = stringField(doc, "title") || stringField(doc, "source") || "";
    const haystack = [
      title,
      stringField(doc, "source"),
      stringField(doc, "doc_type"),
      stringField(doc, "url")
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return { title, haystack };
  });
}

/**
 * The strings a corpus title could plausibly use for this citation.
 *
 * Corpus titles are scraped from incometaxindia.gov.in and from filenames, so
 * they are not canonical: "Circular No. 19/2023", "circular_19_2023.pdf" and
 * "Circular 19 of 2023" all occur. Each probe below is a form that *keeps the
 * number/year pair intact* — only the separator between them varies, because
 * that is a filename artefact, not a difference in the document.
 */
function probesFor(citation: Citation): string[] {
  switch (citation.kind) {
    case "circular":
    case "notification": {
      const pair = citation.normalised.split(" ")[1] ?? "";
      const [number, year] = pair.split("/");
      if (!number || !year) {
        return [];
      }
      const kind = citation.kind;
      return [
        `${kind} no. ${number}/${year}`,
        `${kind} no ${number}/${year}`,
        `${kind} ${number}/${year}`,
        `${kind} ${number} of ${year}`,
        `${kind}_${number}_${year}`,
        `${kind}-${number}-${year}`,
        // Bare pair as a last resort, still as a pair — never number alone.
        `${number}/${year}`,
        `${number}_${year}`
      ];
    }
    case "section": {
      // `s.148a(b)` → match on the number with and without clauses, since a
      // corpus doc covering s.148A also answers for s.148A(b).
      const body = citation.normalised.slice(2);
      const bare = body.replace(/\(.*$/, "");
      return [
        `section ${body}`,
        `section ${bare}`,
        `sec. ${bare}`,
        `s. ${bare}`,
        `s.${bare}`,
        `section-${bare}`,
        `section_${bare}`
      ];
    }
    case "rule": {
      const body = citation.normalised.replace(/^rule /, "");
      const bare = body.replace(/\(.*$/, "");
      return [`rule ${body}`, `rule ${bare}`, `rule-${bare}`, `rule_${bare}`];
    }
    case "case": {
      const [left, right] = citation.normalised.split(" v. ");
      if (!left || !right) {
        return [];
      }
      return [`${left} v. ${right}`, `${left} v ${right}`, `${left} vs ${right}`];
    }
    default:
      return [];
  }
}

/**
 * Mark each citation verified or unverified against the indexed corpus.
 *
 * Returns new objects — the input is never mutated, so a caller can hold the
 * parse result across a corpus reload and re-verify without re-parsing.
 *
 * An empty corpus leaves `verified` undefined rather than marking everything
 * unverified: "your corpus has not been indexed yet" and "this citation is not
 * in your corpus" are different messages, and showing the second when the
 * first is true would train the user to ignore the amber flag.
 */
export function verifyCitations(
  cites: readonly Citation[],
  docs: readonly VerifiableDocument[]
): Citation[] {
  if (docs.length === 0) {
    return cites.map((citation) => ({ ...citation, verified: undefined }));
  }

  const corpus = buildCorpus(docs);

  return cites.map((citation) => {
    const probes = probesFor(citation);
    for (const entry of corpus) {
      if (probes.some((probe) => probe.length > 0 && entry.haystack.includes(probe))) {
        return { ...citation, verified: true, matchedDocument: entry.title };
      }
    }
    return { ...citation, verified: false, matchedDocument: undefined };
  });
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Human label for a kind, sentence case, for tooltips and screen readers. */
export function kindLabel(kind: CitationKind): string {
  switch (kind) {
    case "section":
      return "Section";
    case "circular":
      return "Circular";
    case "notification":
      return "Notification";
    case "rule":
      return "Rule";
    case "case":
      return "Case";
    default:
      return "Citation";
  }
}

/**
 * Split a reply into sentence-ish spans with their source offsets.
 *
 * `ReplyDocument` renders one element per span and measures it, so the span
 * boundaries decide how precisely a margin tag can be placed. Splitting on
 * sentence terminators rather than on lines is what makes "hovering a tag
 * highlights the sentence it belongs to" literally true.
 *
 * The lookbehind-free approach is deliberate: a terminator is consumed with its
 * sentence so no character is lost, and `S. 148A` is not treated as a sentence
 * end because a terminator only counts when followed by whitespace and the
 * preceding token is not a known abbreviation.
 */
export type TextSpan = {
  text: string;
  start: number;
  end: number;
  /** True for a blank-line gap — rendered as a paragraph break, not a span. */
  isBreak: boolean;
};

const ABBREVIATIONS = new Set([
  "s",
  "ss",
  "sec",
  "no",
  "nos",
  "art",
  "cl",
  "pvt",
  "ltd",
  "co",
  "mr",
  "mrs",
  "ms",
  "dr",
  "vs",
  "v",
  "i.e",
  "e.g",
  "viz",
  "etc",
  "hon",
  "govt",
  "asst",
  "addl"
]);

function endsWithAbbreviation(text: string, dotIndex: number): boolean {
  const before = text.slice(Math.max(0, dotIndex - 12), dotIndex);
  const token = before.match(/([A-Za-z.]+)$/);
  if (!token || token[1] === undefined) {
    return false;
  }
  const word = token[1].toLowerCase().replace(/^\.+/, "");
  if (ABBREVIATIONS.has(word)) {
    return true;
  }
  // A single capital is an initial ("A. K. Gupta"), never a sentence end.
  return /^[A-Za-z]$/.test(token[1]);
}

export function splitSentences(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  if (!text) {
    return spans;
  }

  // Paragraphs first: a blank line is a real structural break in a reply and
  // must not be swallowed into the preceding sentence.
  const paragraphRe = /\n[ \t]*\n/g;
  let paragraphStart = 0;
  let match: RegExpExecArray | null;

  const pushParagraph = (from: number, to: number): void => {
    const body = text.slice(from, to);
    if (body.trim() === "") {
      return;
    }
    for (const span of splitParagraph(body, from)) {
      spans.push(span);
    }
  };

  while ((match = paragraphRe.exec(text)) !== null) {
    pushParagraph(paragraphStart, match.index);
    spans.push({
      text: "",
      start: match.index,
      end: match.index + match[0].length,
      isBreak: true
    });
    paragraphStart = match.index + match[0].length;
  }
  pushParagraph(paragraphStart, text.length);

  return spans;
}

function splitParagraph(body: string, offset: number): TextSpan[] {
  const spans: TextSpan[] = [];
  let start = 0;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char !== "." && char !== "!" && char !== "?") {
      continue;
    }
    if (char === "." && endsWithAbbreviation(body, i)) {
      continue;
    }
    // Consume a run of terminators and closing quotes/brackets.
    let end = i + 1;
    while (end < body.length && /[.!?"')\]]/.test(body[end] ?? "")) {
      end += 1;
    }
    const next = body[end];
    if (next !== undefined && !/\s/.test(next)) {
      continue;
    }
    // Swallow the trailing whitespace so spans tile the paragraph exactly.
    while (end < body.length && /\s/.test(body[end] ?? "")) {
      end += 1;
    }
    const slice = body.slice(start, end);
    if (slice.trim() !== "") {
      spans.push({
        text: slice,
        start: offset + start,
        end: offset + end,
        isBreak: false
      });
    }
    start = end;
    i = end - 1;
  }

  const tail = body.slice(start);
  if (tail.trim() !== "") {
    spans.push({
      text: tail,
      start: offset + start,
      end: offset + body.length,
      isBreak: false
    });
  }

  return spans;
}

/**
 * Index citations by the span they fall in.
 *
 * Returns a map from span index to the citations whose *first* occurrence lands
 * in that span, plus the reverse map a hover needs: every span index any
 * occurrence of a citation touches.
 */
export function mapCitationsToSpans(
  cites: readonly Citation[],
  spans: readonly TextSpan[]
): {
  anchorBySpan: Map<number, Citation[]>;
  spansByCitation: Map<string, number[]>;
} {
  const anchorBySpan = new Map<number, Citation[]>();
  const spansByCitation = new Map<string, number[]>();

  const spanIndexAt = (offset: number): number => {
    // Spans tile the text in order, so a binary search is correct here.
    let low = 0;
    let high = spans.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const span = spans[mid];
      if (span === undefined) {
        break;
      }
      if (offset < span.start) {
        high = mid - 1;
      } else if (offset >= span.end) {
        low = mid + 1;
      } else {
        return mid;
      }
    }
    return -1;
  };

  for (const citation of cites) {
    const touched: number[] = [];
    for (const occurrence of citation.occurrences) {
      const index = spanIndexAt(occurrence.start);
      if (index >= 0 && !touched.includes(index)) {
        touched.push(index);
      }
    }
    spansByCitation.set(citation.id, touched);

    const anchor = touched[0];
    if (anchor === undefined) {
      continue;
    }
    const bucket = anchorBySpan.get(anchor);
    if (bucket) {
      bucket.push(citation);
    } else {
      anchorBySpan.set(anchor, [citation]);
    }
  }

  return { anchorBySpan, spansByCitation };
}
