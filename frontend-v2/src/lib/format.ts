/**
 * Pure formatting helpers. No DOM, no bridge, no React — so they are testable
 * in isolation and safe to call during render.
 *
 * Every function takes untrusted input: backend timestamps can be null, a cron
 * string comes from a hand-edited config.json, and a chunk count can arrive as
 * a non-number. Each returns a displayable string rather than throwing, because
 * a malformed status field must not blank the screen it appears on.
 */

const ONE_MINUTE = 60;
const ONE_HOUR = 3_600;
const ONE_DAY = 86_400;
const ONE_WEEK = 604_800;

/**
 * Parse a backend timestamp.
 *
 * The backend writes `datetime.now(timezone.utc).isoformat()`, which yields
 * `+00:00` and parses correctly. Session files and some older status writes can
 * carry a naive `2026-10-13T09:00:00` with no zone; `Date` reads those as local
 * time -- correct here, because the backend writing the stamp and the renderer
 * reading it are the same machine, so no fixup is applied.
 */
function parseTimestamp(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * "4 minutes ago" / "in 3 hours". Past and future both, because the same
 * helper renders `last_sync` and `next_scheduled_sync`.
 *
 * `now` is injectable so a test does not depend on the wall clock.
 */
export function formatRelativeTime(
  value: string | Date | null | undefined,
  now: Date = new Date()
): string {
  const date = value instanceof Date ? value : parseTimestamp(value);
  if (!date) {
    return "Never";
  }

  const deltaSeconds = (date.getTime() - now.getTime()) / 1000;
  const future = deltaSeconds > 0;
  const magnitude = Math.abs(deltaSeconds);

  if (magnitude < 45) {
    return future ? "In a moment" : "Just now";
  }

  const unit = (count: number, singular: string): string => {
    const rounded = Math.round(count);
    const noun = rounded === 1 ? singular : `${singular}s`;
    return future ? `In ${rounded} ${noun}` : `${rounded} ${noun} ago`;
  };

  if (magnitude < ONE_HOUR) {
    return unit(magnitude / ONE_MINUTE, "minute");
  }
  if (magnitude < ONE_DAY) {
    return unit(magnitude / ONE_HOUR, "hour");
  }
  if (magnitude < ONE_WEEK) {
    return unit(magnitude / ONE_DAY, "day");
  }
  // Past a week a relative figure stops being useful to someone working to a
  // statutory deadline — give them the date.
  return formatAbsolute(date);
}

/** "13 Oct 2026, 14:32" — day-first, as an Indian practice reads a date. */
export function formatAbsolute(value: string | Date | null | undefined): string {
  const date = value instanceof Date ? value : parseTimestamp(value);
  if (!date) {
    return "Never";
  }
  const day = date.getDate().toString().padStart(2, "0");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ] as const;
  const month = months[date.getMonth()] ?? "";
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${day} ${month} ${date.getFullYear()}, ${hours}:${minutes}`;
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

/**
 * Field ranges, mirroring `src-tauri/src/config.rs::is_valid_cron`. The host
 * rejects the save, so client validation that disagrees either blocks a legal
 * value or lets an illegal one through to a confusing round trip.
 */
const CRON_FIELDS = [
  { lo: 0, hi: 59 },
  { lo: 0, hi: 23 },
  { lo: 1, hi: 31 },
  { lo: 1, hi: 12 },
  // Day-of-week runs to 7, not 6: cron spells Sunday both 0 and 7, and both
  // `src-tauri/src/config.rs` and `backend-rs/src/config.rs` accept it. A
  // narrower range here is the exact failure the comment above warns about
  // -- the UI would call a schedule invalid that saves and runs fine, and a
  // config inherited from v1 could show as broken.
  { lo: 0, hi: 7 }
] as const;

function isValidCronField(field: string, lo: number, hi: number): boolean {
  if (field === "") {
    return false;
  }
  return field.split(",").every((part) => {
    if (part === "") {
      return false;
    }
    // An optional step: "*/15" or "1-30/5".
    const slash = part.indexOf("/");
    const base = slash === -1 ? part : part.slice(0, slash);
    if (slash !== -1) {
      const step = part.slice(slash + 1);
      if (!/^\d+$/.test(step) || Number(step) === 0) {
        return false;
      }
    }
    if (base === "*") {
      return true;
    }
    const bounds = base.split("-");
    if (bounds.length > 2) {
      return false;
    }
    return bounds.every(
      (n) => /^\d+$/.test(n) && Number(n) >= lo && Number(n) <= hi
    );
  });
}

/** True when the host's `is_valid_cron` would accept this expression. */
export function isValidCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== CRON_FIELDS.length) {
    return false;
  }
  return fields.every((field, index) => {
    const range = CRON_FIELDS[index];
    return range !== undefined && isValidCronField(field, range.lo, range.hi);
  });
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
] as const;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
] as const;

function listNames(field: string, names: readonly string[], offset: number): string | null {
  const parts = field.split(",");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const name = names[Number(part) - offset];
    if (name === undefined) {
      return null;
    }
    resolved.push(name);
  }
  if (resolved.length === 1) {
    return resolved[0] ?? null;
  }
  const last = resolved.pop();
  return `${resolved.join(", ")} and ${last}`;
}

/**
 * Plain-English gloss of a cron expression: `0 12 * * *` becomes
 * "Every day at 12:00".
 *
 * Deliberately not a full cron grammar. It covers what the schedule picker can
 * produce plus the common hand-edits, and falls back to echoing the expression
 * when it cannot describe one faithfully — a wrong description of when a sync
 * runs is worse than no description.
 */
export function describeCron(expression: string): string {
  const raw = expression.trim();
  if (raw === "") {
    return "No schedule set";
  }
  if (!isValidCron(raw)) {
    return "Not a valid schedule";
  }

  const fields = raw.split(/\s+/);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string
  ];

  // The time half.
  let time: string;
  if (minute === "*" && hour === "*") {
    time = "every minute";
  } else if (hour === "*" && /^\d+$/.test(minute)) {
    time = `at ${minute.padStart(2, "0")} minutes past every hour`;
  } else if (/^\*\/(\d+)$/.test(minute) && hour === "*") {
    const step = /^\*\/(\d+)$/.exec(minute)?.[1] ?? "";
    time = `every ${step} minutes`;
  } else if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    time = `at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  } else if (/^\d+$/.test(minute) && /^\*\/(\d+)$/.test(hour)) {
    const step = /^\*\/(\d+)$/.exec(hour)?.[1] ?? "";
    time = `every ${step} hours at ${minute.padStart(2, "0")} minutes past`;
  } else {
    return raw;
  }

  // The day half. A cron with both day-of-month and day-of-week restricted is
  // an OR in most implementations and routinely misread, so it is not glossed.
  const dayRestricted = dayOfMonth !== "*";
  const weekdayRestricted = dayOfWeek !== "*";
  if (dayRestricted && weekdayRestricted) {
    return raw;
  }
  if (month !== "*" && !/^[\d,]+$/.test(month)) {
    return raw;
  }

  let day: string;
  if (weekdayRestricted) {
    // Cron allows 7 for Sunday; the host's range stops at 6, so 0 is the only
    // Sunday that can reach here.
    const names = listNames(dayOfWeek, DAY_NAMES, 0);
    if (names === null) {
      return raw;
    }
    day = `every ${names}`;
  } else if (dayRestricted) {
    if (!/^[\d,]+$/.test(dayOfMonth)) {
      return raw;
    }
    const days = dayOfMonth
      .split(",")
      .map((d) => `day ${Number(d)}`)
      .join(", ");
    day = `on ${days}`;
  } else {
    day = "every day";
  }

  const monthPart =
    month === "*" ? "" : ` in ${listNames(month, MONTH_NAMES, 1) ?? month}`;

  const sentence = `${day} ${time}${monthPart}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/* ---------------------------------------------------------------------------
   The schedule picker's cron, composed and read back.

   Settings offers frequency + the detail that frequency implies -- a weekday
   when it is weekly -- and a time in every case. That is three controls over
   one cron string, so the mapping both ways lives here rather than in the
   component, where it could not be tested without rendering.

   Monthly is deliberately not offered. A corpus that refreshes once a month
   is stale for most of it, and the two useful cadences are daily and weekly.
   A monthly cron inherited from v1 or written in Advanced still RUNS -- the
   host and backend validate it exactly as before; it simply has no preset,
   so `cronToSchedule` returns null for it and the caller shows the raw
   expression rather than a picker that would rewrite it on the next save.
--------------------------------------------------------------------------- */

export type ScheduleFrequency = "daily" | "weekly";

export type Schedule = {
  frequency: ScheduleFrequency;
  /** 0 = Sunday. Only meaningful when `frequency` is `weekly`. */
  weekday: number;
  /** `HH:MM`, the value an `<input type="time">` exchanges. */
  time: string;
};

export const DEFAULT_SCHEDULE: Schedule = {
  frequency: "daily",
  weekday: 1,
  time: "12:00"
};

/** Builds the 5-field cron a [`Schedule`] means. */
export function scheduleToCron(schedule: Schedule): string {
  const [rawHour, rawMinute] = schedule.time.split(":");
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  // A half-typed time ("1:" while the user is still going) must not produce
  // `NaN NaN * * *` and fail validation on a field they already filled in.
  const h = Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 12;
  const m = Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0;

  switch (schedule.frequency) {
    case "weekly":
      return `${m} ${h} * * ${schedule.weekday}`;
    default:
      return `${m} ${h} * * *`;
  }
}

/**
 * Reads a cron back into the picker's three controls.
 *
 * Returns `null` for anything the controls cannot represent -- a step, a
 * list, a month restriction, a day-of-month (monthly) schedule, both day
 * fields at once. The caller shows the raw expression in that case rather
 * than a picker that would silently rewrite it into something simpler on the
 * next save.
 */
export function cronToSchedule(expression: string): Schedule | null {
  const raw = expression.trim();
  if (!isValidCron(raw)) {
    return null;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = raw.split(/\s+/) as [
    string,
    string,
    string,
    string,
    string
  ];

  const plain = (f: string): boolean => /^\d+$/.test(f);
  if (!plain(minute) || !plain(hour) || month !== "*") {
    return null;
  }

  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

  if (dayOfWeek !== "*") {
    // Both restricted is an OR in cron and routinely misread; it is not
    // something these controls can express.
    if (dayOfMonth !== "*" || !plain(dayOfWeek)) {
      return null;
    }
    // Cron spells Sunday both 0 and 7 and the host accepts both, so a 7 does
    // reach here. The picker has one Sunday, so it is normalised to 0 --
    // otherwise `String(schedule.weekday)` would be "7", match no option in
    // the select, and the control would render blank for a valid schedule.
    const weekday = Number(dayOfWeek) % 7;
    return { ...DEFAULT_SCHEDULE, frequency: "weekly", weekday, time };
  }

  // A day-of-month restriction is a monthly schedule, which the picker no
  // longer offers. It stays valid and keeps running; it just has no control
  // to show, so the caller falls back to the raw expression.
  if (dayOfMonth !== "*") {
    return null;
  }

  return { ...DEFAULT_SCHEDULE, frequency: "daily", time };
}

/* ---------------------------------------------------------------------------
   The time-of-day options.

   `<input type="time">` was the first attempt and was replaced: WebView2
   renders its own dropdown, which is two scrolling number columns in OS
   chrome -- a white-on-blue selection and a grey panel that ignore the theme
   completely, in the middle of a dark settings panel. It is also the wrong
   shape for the question. This picks when a background index refresh runs;
   nobody needs 14:37, and 1440 values for a choice that is really "overnight"
   or "around lunch" is precision nobody asked for.

   So: a themed select of every half hour, grouped by part of the day. 48
   options is a long list to scroll blind, but grouped it is four short ones,
   and the group a time belongs to is how people actually name it.

   The native input had exactly one real advantage -- it knew the machine's
   12h/24h convention, which a pair of number fields would get wrong for half
   the world. `Intl.DateTimeFormat` knows the same thing from the same source,
   so the labels read "9:30 am" on this machine and "09:30" where that is the
   convention, with no OS chrome attached.
--------------------------------------------------------------------------- */

/**
 * Formats a 24-hour `HH:MM` the way this machine writes times.
 *
 * Built once per call rather than held in a module constant: a formatter
 * captures the locale at construction, and this process can outlive a
 * settings change. The cost is nil next to rendering a select.
 *
 * Falls back to the input unchanged if `Intl` throws, which it can for a
 * malformed locale -- a readable 24-hour label beats an empty option.
 */
/**
 * `HH:MM` -> hour and minute, or `null` if it is neither.
 *
 * `noUncheckedIndexedAccess` is on, so a destructure of `split` is
 * `number | undefined` and every caller would otherwise need the same two
 * guards. One place to be wrong instead of two.
 */
function parseHhMm(value: string): { hour: number; minute: number } | null {
  const parts = value.split(":");
  if (parts.length !== 2) {
    return null;
  }
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }
  return { hour, minute };
}

export function formatTimeOfDay(value: string): string {
  const parsed = parseHhMm(value);
  if (parsed === null) {
    return value;
  }
  const { hour: h, minute: m } = parsed;
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit"
    })
      .format(new Date(2026, 0, 1, h, m))
      // Some locales use a narrow no-break space before am/pm, which looks
      // like a rendering fault in a short label.
      .replace(/\u202f/g, " ");
  } catch {
    return value;
  }
}

