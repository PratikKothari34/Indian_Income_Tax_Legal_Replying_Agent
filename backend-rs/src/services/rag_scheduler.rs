//! Cron-driven corpus sync. Ports `backend/services/rag_scheduler.py`.
//!
//! v1 leaned on APScheduler. There is no reason to carry an equivalent
//! dependency here: the whole requirement is "fire once per matching
//! minute", which is a one-minute tokio ticker plus a five-field cron
//! match. That also removes v1's worst startup hazard — an unbuildable
//! cron expression from the Settings panel used to take the backend down
//! at import time, because the trigger was constructed eagerly. Here an
//! invalid expression falls back to the default and the server starts.
//!
//! Three guarantees carried over verbatim, because each one was a bug
//! fixed in v1:
//!
//! * **Scheduled and manual triggers are mutually exclusive**, through one
//!   process-wide lock.
//! * **A second caller skips rather than queues.** `POST /rag/sync` is
//!   fire-and-forget; a queued caller fires a duplicate scrape the instant
//!   the first finishes.
//! * **Status lives in `sync_status-rs.json`**, not in memory, so
//!   `GET /rag/status` survives a restart — and the write merges, because
//!   the scraper owns `known_urls` in the same file.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local, Timelike, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rag_embedder, rag_scraper};
use crate::config::{self, AppConfig};
use crate::paths;

pub const DEFAULT_CRON: &str = "0 12 * * *";

/// Cap on persisted error strings, so the status file stays small.
const MAX_PERSISTED_ERRORS: usize = 50;

/// A sync is forced at boot when the last one is older than this.
const STALE_AFTER_HOURS: i64 = 24;

fn sync_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Mirrors the lock's state without acquiring it.
///
/// `Mutex::try_lock` answers the same question, but taking the guard to
/// inspect it and dropping it immediately is a race: another caller could
/// slip in between. A flag set inside the critical section is exact.
static SYNC_RUNNING: AtomicBool = AtomicBool::new(false);

pub fn is_running() -> bool {
    SYNC_RUNNING.load(Ordering::SeqCst)
}

/// Run `job` as the only corpus-mutating task, or return `None` if one is
/// already running.
///
/// Both a sync and a reindex walk the same vector store, the same scraped
/// `.txt` files and the same `sync_status-rs.json`. Interleaving them loses
/// `known_urls` -- a reindex's `clear_dedup_cache` deletes the status file
/// under a running sync, which then merges its results into a file that no
/// longer exists, and the next sync re-downloads the entire corpus. A reindex
/// landing mid-sync can also wipe the store between the sync's scrape and
/// embed phases, leaving duplicate chunks for every document.
///
/// Every such task goes through here so the lock cannot be forgotten: it was
/// forgotten once already, on `rag_reindex`.
pub async fn run_exclusive<F, T>(job: F) -> Option<T>
where
    F: std::future::Future<Output = T>,
{
    let Ok(guard) = sync_lock().try_lock() else {
        return None;
    };
    SYNC_RUNNING.store(true, Ordering::SeqCst);
    let result = job.await;
    SYNC_RUNNING.store(false, Ordering::SeqCst);
    drop(guard);
    Some(result)
}

// --- status file ----------------------------------------------------------

fn read_status_raw() -> HashMap<String, Value> {
    std::fs::read_to_string(paths::rag_sync_status())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Merge `updates` into the status file.
///
/// Must merge, never replace: `known_urls` is written by the scraper and
/// losing it makes the next sync re-download the entire corpus.
fn write_status(updates: HashMap<String, Value>) {
    let _ = paths::ensure_dirs();
    let path = paths::rag_sync_status();
    let mut payload = read_status_raw();
    payload.extend(updates);

    // Unique temp name, then rename. The scraper writes this same file and
    // a reindex can delete it mid-sync, so a transient Windows sharing
    // violation must not crash the sync.
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let body = match serde_json::to_vec_pretty(&payload) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("could not serialise sync status: {e}");
            return;
        }
    };
    if let Err(e) = std::fs::write(&tmp, body) {
        tracing::warn!("could not write sync status: {e}");
        let _ = std::fs::remove_file(&tmp);
        return;
    }
    // One retry: the rename is the step that loses to a concurrent reader
    // holding the handle open on Windows.
    if std::fs::rename(&tmp, &path).is_err() {
        std::thread::sleep(std::time::Duration::from_millis(120));
        if let Err(e) = std::fs::rename(&tmp, &path) {
            tracing::warn!("could not replace sync status: {e}");
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// The shape `GET /rag/status` returns, minus `next_scheduled_sync`
/// (computed in the route from the live schedule).
#[derive(Debug, Serialize)]
pub struct SyncStatusView {
    pub last_sync: Option<String>,
    pub docs_total: usize,
    pub docs_added_last_run: usize,
    pub last_sync_status: String,
    pub errors: Vec<String>,
}

pub fn get_status() -> SyncStatusView {
    let raw = read_status_raw();
    let num = |k: &str| -> usize { raw.get(k).and_then(|v| v.as_u64()).unwrap_or(0) as usize };
    SyncStatusView {
        last_sync: raw
            .get("last_sync")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        docs_total: num("docs_total"),
        docs_added_last_run: num("docs_added_last_run"),
        last_sync_status: raw
            .get("last_sync_status")
            .and_then(|v| v.as_str())
            .unwrap_or("never")
            .to_string(),
        errors: raw
            .get("errors")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

#[derive(Debug, Serialize)]
pub struct DedupClearReport {
    pub status_cleared: bool,
    pub txt_removed: usize,
}

/// Wipe the scrape dedup state so the next sync re-fetches everything.
///
/// Called by `POST /rag/reindex`. After a reindex the `known_urls` set is
/// stale and would make the next sync fetch nothing, so it goes, and with
/// it every API-fetched `.txt`. **`.pdf` files are left alone** — those are
/// the user's own uploads and are not re-downloadable.
pub fn clear_dedup_cache() -> DedupClearReport {
    let status_path = paths::rag_sync_status();
    let mut status_cleared = false;
    if status_path.exists() {
        match std::fs::remove_file(&status_path) {
            Ok(()) => {
                status_cleared = true;
                tracing::info!("[reindex] cleared sync status - known_urls reset");
            }
            Err(e) => tracing::warn!("[reindex] could not delete the sync status file: {e}"),
        }
    }

    let mut txt_removed = 0usize;
    let mut files = Vec::new();
    collect_txt(&paths::rag_docs_dir(), 0, &mut files);
    for f in files {
        match std::fs::remove_file(&f) {
            Ok(()) => txt_removed += 1,
            Err(e) => tracing::warn!("[reindex] could not delete {}: {e}", f.display()),
        }
    }
    tracing::info!("[reindex] removed {txt_removed} text file(s) - will re-fetch on next sync");

    DedupClearReport {
        status_cleared,
        txt_removed,
    }
}

fn collect_txt(dir: &std::path::Path, depth: usize, out: &mut Vec<std::path::PathBuf>) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => collect_txt(&path, depth + 1, out),
            Ok(ft) if ft.is_file() => {
                if path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("txt"))
                    .unwrap_or(false)
                {
                    out.push(path);
                }
            }
            _ => {}
        }
    }
}

// --- the pipeline ---------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct SyncOutcome {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
    pub status: String,
    pub docs_added: usize,
    pub chunks_added: usize,
    pub docs_total: usize,
    pub errors: Vec<String>,
}

/// One sync cycle. Lock-protected; a concurrent caller is told it was
/// skipped rather than made to wait.
pub async fn run_sync() -> SyncOutcome {
    match run_exclusive(run_sync_inner()).await {
        Some(outcome) => outcome,
        None => {
            tracing::info!("run_sync: skipped - another corpus job is already in progress");
            SyncOutcome {
                skipped: true,
                status: "already_running".into(),
                docs_added: 0,
                chunks_added: 0,
                docs_total: 0,
                errors: Vec::new(),
            }
        }
    }
}

async fn run_sync_inner() -> SyncOutcome {
    let started_at = Utc::now().format("%Y-%m-%dT%H:%M:%S+00:00").to_string();
    let mut errors: Vec<String> = Vec::new();
    let mut status = "success";

    let cfg = config::load();

    // Phase 1 - scrape. Unlike v1 there is no "crashed" path to guard:
    // scrape_all_sources returns a report and folds every failure into it.
    let scrape = rag_scraper::scrape_all_sources(&cfg).await;
    if !scrape.sources_bad.is_empty() {
        status = "partial";
    }
    errors.extend(scrape.errors.iter().cloned());
    let docs_added = scrape.downloaded.len();

    // Phase 2 - embed.
    let chunks_added = rag_embedder::ingest_many(&scrape.downloaded).await;

    // Phase 2b - supersession detection. A superseded circular served as
    // current law is the exact failure this product exists to prevent, so
    // this runs every sync, not only when something new arrived.
    let marked = rag_embedder::detect_supersessions().await;
    if marked > 0 {
        tracing::info!("supersession pass marked {marked} chunk(s)");
    }

    // Phase 3 - totals.
    let docs_total = rag_embedder::list_documents().await.len();

    let finished_at = Utc::now().format("%Y-%m-%dT%H:%M:%S+00:00").to_string();
    tracing::info!(
        "sync done - added={docs_added} chunks={chunks_added} total={docs_total} \
         status={status} errors={}",
        errors.len()
    );

    errors.truncate(MAX_PERSISTED_ERRORS);
    let mut updates: HashMap<String, Value> = HashMap::new();
    updates.insert("last_sync".into(), json!(finished_at));
    updates.insert("last_sync_started".into(), json!(started_at));
    updates.insert("last_sync_status".into(), json!(status));
    updates.insert("docs_added_last_run".into(), json!(docs_added));
    updates.insert("chunks_added_last_run".into(), json!(chunks_added));
    updates.insert("docs_total".into(), json!(docs_total));
    updates.insert("errors".into(), json!(errors));
    write_status(updates);

    SyncOutcome {
        skipped: false,
        status: status.into(),
        docs_added,
        chunks_added,
        docs_total,
        errors,
    }
}

// --- cron -----------------------------------------------------------------

/// A validated five-field cron schedule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronSchedule {
    fields: [String; 5],
}

/// Field bounds, in cron order. Day-of-week allows 7 as a second Sunday.
const FIELD_RANGES: [(u32, u32); 5] = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)];

impl CronSchedule {
    /// Parse, falling back to [`DEFAULT_CRON`] on anything unusable.
    ///
    /// Field *count* alone is not enough: `"99 99 99 99 99"` has five
    /// fields and every one is out of range. v1 discovered that only when
    /// APScheduler built the trigger, at import time, which took the whole
    /// backend down over a user-editable Settings value.
    pub fn parse_or_default(expr: &str) -> Self {
        match Self::parse(expr) {
            Some(s) => s,
            None => {
                tracing::warn!("cron {expr:?} is not a valid schedule - using {DEFAULT_CRON:?}");
                Self::parse(DEFAULT_CRON).expect("the default cron must parse")
            }
        }
    }

    pub fn parse(expr: &str) -> Option<Self> {
        let parts: Vec<&str> = expr.split_whitespace().collect();
        if parts.len() != 5 {
            return None;
        }
        for (i, part) in parts.iter().enumerate() {
            if !field_is_valid(part, FIELD_RANGES[i]) {
                return None;
            }
        }
        Some(Self {
            fields: [
                parts[0].into(),
                parts[1].into(),
                parts[2].into(),
                parts[3].into(),
                parts[4].into(),
            ],
        })
    }

    pub fn expr(&self) -> String {
        self.fields.join(" ")
    }

    /// True when `when` falls in a minute this schedule fires on.
    ///
    /// Local time, matching v1: a user setting "noon" means noon where
    /// they are, not UTC.
    pub fn matches(&self, when: &DateTime<Local>) -> bool {
        let dow = when.weekday().num_days_from_sunday();
        field_matches(&self.fields[0], when.minute(), FIELD_RANGES[0])
            && field_matches(&self.fields[1], when.hour(), FIELD_RANGES[1])
            && field_matches(&self.fields[2], when.day(), FIELD_RANGES[2])
            && field_matches(&self.fields[3], when.month(), FIELD_RANGES[3])
            && dow_matches(&self.fields[4], dow)
    }

    /// Next firing time strictly after `after`, scanning minute by minute.
    ///
    /// Bounded to roughly 366 days: a schedule like `0 0 30 2 *` (30
    /// February) never fires, and an unbounded scan would spin forever.
    pub fn next_after(&self, after: &DateTime<Local>) -> Option<DateTime<Local>> {
        let mut cursor =
            after.with_second(0)?.with_nanosecond(0)? + ChronoDuration::minutes(1);
        for _ in 0..(366 * 24 * 60) {
            if self.matches(&cursor) {
                return Some(cursor);
            }
            cursor += ChronoDuration::minutes(1);
        }
        None
    }
}

/// Validate one cron field: `*`, `*/n`, `a-b`, `a-b/n`, a number, or a
/// comma-separated list of those.
fn field_is_valid(field: &str, range: (u32, u32)) -> bool {
    if field.is_empty() {
        return false;
    }
    field.split(',').all(|part| {
        if part.is_empty() {
            return false;
        }
        let (spec, step) = match part.split_once('/') {
            Some((s, st)) => match st.parse::<u32>() {
                Ok(n) if n >= 1 => (s, Some(n)),
                _ => return false,
            },
            None => (part, None),
        };
        if spec == "*" {
            return true;
        }
        if let Some((lo, hi)) = spec.split_once('-') {
            return match (lo.parse::<u32>(), hi.parse::<u32>()) {
                (Ok(lo), Ok(hi)) => lo <= hi && lo >= range.0 && hi <= range.1,
                _ => false,
            };
        }
        match spec.parse::<u32>() {
            // A bare number with a step is meaningless ("5/2") and is
            // rejected rather than silently read as "5".
            Ok(n) => step.is_none() && n >= range.0 && n <= range.1,
            Err(_) => false,
        }
    })
}

fn field_matches(field: &str, value: u32, range: (u32, u32)) -> bool {
    field.split(',').any(|part| {
        let (spec, step) = match part.split_once('/') {
            Some((s, st)) => (s, st.parse::<u32>().unwrap_or(1).max(1)),
            None => (part, 1),
        };
        let (lo, hi) = if spec == "*" {
            range
        } else if let Some((a, b)) = spec.split_once('-') {
            match (a.parse::<u32>(), b.parse::<u32>()) {
                (Ok(a), Ok(b)) => (a, b),
                _ => return false,
            }
        } else {
            match spec.parse::<u32>() {
                Ok(n) => (n, n),
                Err(_) => return false,
            }
        };
        value >= lo && value <= hi && (value - lo) % step == 0
    })
}

/// Day-of-week match, normalising 7 to 0 so both spellings of Sunday work.
fn dow_matches(field: &str, dow: u32) -> bool {
    if field_matches(field, dow, FIELD_RANGES[4]) {
        return true;
    }
    if dow == 0 {
        return field_matches(field, 7, FIELD_RANGES[4]);
    }
    false
}

// --- the loop -------------------------------------------------------------

fn next_run_slot() -> &'static std::sync::Mutex<Option<DateTime<Local>>> {
    static SLOT: OnceLock<std::sync::Mutex<Option<DateTime<Local>>>> = OnceLock::new();
    SLOT.get_or_init(|| std::sync::Mutex::new(None))
}

/// Best-effort ISO timestamp of the next scheduled sync.
pub fn next_scheduled_sync_iso() -> Option<String> {
    next_run_slot()
        .lock()
        .ok()
        .and_then(|g| *g)
        .map(|t| t.format("%Y-%m-%dT%H:%M:%S%:z").to_string())
}

/// True when the store is empty or the last sync is over 24 h old.
///
/// A read failure answers `true`: a redundant sync on boot costs minutes,
/// a missed one costs the user a stale corpus with no signal.
async fn should_run_now() -> bool {
    let raw = read_status_raw();
    let Some(last) = raw.get("last_sync").and_then(|v| v.as_str()) else {
        return true;
    };
    let Ok(parsed) = DateTime::parse_from_rfc3339(last) else {
        return true;
    };
    if (Utc::now() - parsed.with_timezone(&Utc)).num_hours() >= STALE_AFTER_HOURS {
        return true;
    }
    rag_embedder::collection_size().await == 0
}

/// Start the background scheduler.
///
/// Returns the task handle so `main` can abort it on shutdown. Never
/// errors: the sync is a background convenience and must never be the
/// reason the backend refuses to start.
pub fn spawn(cfg: &AppConfig) -> tokio::task::JoinHandle<()> {
    let schedule = CronSchedule::parse_or_default(&cfg.rag_sync_schedule);
    tracing::info!("scheduler started - cron={:?}", schedule.expr());

    tokio::spawn(async move {
        if let Ok(mut slot) = next_run_slot().lock() {
            *slot = schedule.next_after(&Local::now());
        }

        if should_run_now().await {
            tracing::info!("running initial sync (store empty or over 24 h since the last)");
            run_sync().await;
        }

        // Tick on the minute boundary rather than every 60 s from boot, so
        // a sync scheduled for 12:00 does not drift to 12:00:43 and then
        // further on every restart.
        loop {
            let now = Local::now();
            let wait = 60 - now.second() as u64;
            tokio::time::sleep(std::time::Duration::from_secs(wait.max(1))).await;

            let tick = Local::now();
            if schedule.matches(&tick) {
                tracing::info!("cron fired at {}", tick.format("%Y-%m-%d %H:%M"));
                run_sync().await;
            }
            if let Ok(mut slot) = next_run_slot().lock() {
                *slot = schedule.next_after(&Local::now());
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn local(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(y, m, d, h, min, 0)
            .single()
            .expect("unambiguous local time")
    }

    #[test]
    fn the_default_schedule_is_noon_daily() {
        let s = CronSchedule::parse_or_default(DEFAULT_CRON);
        assert!(s.matches(&local(2026, 10, 13, 12, 0)));
        assert!(!s.matches(&local(2026, 10, 13, 12, 1)));
        assert!(!s.matches(&local(2026, 10, 13, 11, 0)));
    }

    #[test]
    fn five_in_range_fields_are_required() {
        // The case that took v1's backend down at startup: five fields,
        // every one out of range.
        assert!(CronSchedule::parse("99 99 99 99 99").is_none());
        assert!(CronSchedule::parse("0 12 * *").is_none(), "four fields");
        assert!(CronSchedule::parse("0 12 * * * *").is_none(), "six fields");
        assert!(CronSchedule::parse("").is_none());
        assert!(CronSchedule::parse("not a cron at all!").is_none());
        assert!(CronSchedule::parse("0 12 * * *").is_some());
    }

    #[test]
    fn an_invalid_expression_degrades_to_the_default_instead_of_failing() {
        assert_eq!(CronSchedule::parse_or_default("garbage").expr(), DEFAULT_CRON);
    }

    #[test]
    fn steps_ranges_and_lists_all_parse_and_match() {
        let every_15 = CronSchedule::parse("*/15 * * * *").unwrap();
        assert!(every_15.matches(&local(2026, 10, 13, 9, 0)));
        assert!(every_15.matches(&local(2026, 10, 13, 9, 45)));
        assert!(!every_15.matches(&local(2026, 10, 13, 9, 7)));

        let business = CronSchedule::parse("0 9-17 * * 1-5").unwrap();
        assert!(business.matches(&local(2026, 10, 13, 10, 0))); // Tuesday
        assert!(!business.matches(&local(2026, 10, 13, 18, 0)));
        assert!(!business.matches(&local(2026, 10, 11, 10, 0))); // Sunday

        let list = CronSchedule::parse("0,30 6,18 * * *").unwrap();
        assert!(list.matches(&local(2026, 10, 13, 6, 30)));
        assert!(list.matches(&local(2026, 10, 13, 18, 0)));
        assert!(!list.matches(&local(2026, 10, 13, 7, 0)));
    }

    #[test]
    fn a_bare_number_with_a_step_is_rejected() {
        // "5/2" is meaningless; reading it as "5" would silently fire at a
        // time the user did not ask for.
        assert!(CronSchedule::parse("5/2 * * * *").is_none());
        assert!(CronSchedule::parse("*/0 * * * *").is_none(), "zero step");
    }

    #[test]
    fn sunday_matches_as_both_zero_and_seven() {
        let zero = CronSchedule::parse("0 12 * * 0").unwrap();
        let seven = CronSchedule::parse("0 12 * * 7").unwrap();
        let sunday = local(2026, 10, 11, 12, 0);
        assert!(zero.matches(&sunday));
        assert!(seven.matches(&sunday));
    }

    #[test]
    fn next_after_is_strictly_later() {
        let s = CronSchedule::parse("0 12 * * *").unwrap();
        let noon = local(2026, 10, 13, 12, 0);
        let next = s.next_after(&noon).expect("a daily schedule always fires");
        assert!(next > noon, "must not return the same minute again");
        assert_eq!(next.hour(), 12);
        assert_eq!(next.minute(), 0);
        assert_eq!(next.day(), 14);
    }

    #[test]
    fn a_schedule_that_can_never_fire_terminates() {
        // 30 February. An unbounded minute-by-minute scan would hang.
        let s = CronSchedule::parse("0 0 30 2 *").unwrap();
        assert!(s.next_after(&local(2026, 10, 13, 12, 0)).is_none());
    }

    #[test]
    fn day_of_month_and_month_bounds_are_enforced() {
        assert!(CronSchedule::parse("0 0 0 * *").is_none(), "day 0 does not exist");
        assert!(CronSchedule::parse("0 0 32 * *").is_none());
        assert!(CronSchedule::parse("0 0 1 * *").is_some());
        assert!(CronSchedule::parse("0 0 * 13 *").is_none(), "month 13");
    }

    /// A reindex and a sync must never run together: they share the vector
    /// store, the scraped `.txt` files and `sync_status-rs.json`, and
    /// interleaving them loses `known_urls` and re-downloads the corpus.
    /// `rag_reindex` shipped without the lock that `run_sync` had.
    #[tokio::test]
    async fn two_corpus_jobs_cannot_overlap() {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();

        // Hold the lock inside a job that does not finish until told to.
        let first = tokio::spawn(run_exclusive(async move {
            let _ = rx.await;
            "first"
        }));

        // Wait until the flag confirms the first job owns the lock, rather
        // than sleeping a guessed interval.
        for _ in 0..200 {
            if is_running() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(is_running(), "the first job should hold the lock");

        // A second job must be refused, not queued.
        let second = run_exclusive(async { "second" }).await;
        assert!(second.is_none(), "a concurrent corpus job must be skipped");

        let _ = tx.send(());
        assert_eq!(first.await.expect("join"), Some("first"));

        // The flag must clear, or the UI shows a job running forever.
        assert!(!is_running(), "the flag must clear when the job ends");

        // And the lock must be reusable afterwards.
        assert_eq!(run_exclusive(async { "third" }).await, Some("third"));
    }
}
