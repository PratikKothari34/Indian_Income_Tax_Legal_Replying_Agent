"""Hybrid RAG ingestion: manual drop-folder + Indian Kanoon REST API.

Phase 2 RAG, post-Playwright pivot. Earlier iterations attempted
headless-Chromium scraping of ``incometaxindia.gov.in``; every request
was rejected at Akamai's edge with HTTP 403, no React app ever
rendered. We now use Indian Kanoon (``api.indiankanoon.org``), a
clean REST surface that exposes the same source material (CBDT
circulars, notifications, Finance Acts, Income Tax Act / Rules) with
predictable JSON.

Two ingestion paths feed the same pipeline:

1. **Manual drop folder** — :func:`ingest_local_documents` scans
   :data:`RAG_DOCS_DIR` (recursive) for user-supplied PDFs / DOCX /
   TXT and validates each one.
2. **Indian Kanoon API** — :func:`scrape_indian_kanoon` runs a
   handful of search queries, fetches metadata + full text for each
   new document, strips HTML, and writes a ``.txt`` file under
   ``RAG_DOCS_DIR/<doc_type>/``. The manual-ingest path then picks
   the new file up on its second sweep.

Both paths funnel through the same dedup set (``known_urls`` in
``sync_status.json``) and the same embedder. ``scrape_all_sources``
preserves the historical signature so the scheduler does not change.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from paths import RAG_DOCS_DIR, RAG_SYNC_STATUS, get_rag_logger, load_config

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SUPPORTED_EXTS: frozenset[str] = frozenset({".pdf", ".docx", ".txt"})

#: Indian Kanoon API endpoints (all POST, per their documentation).
IK_API_BASE = "https://api.indiankanoon.org"
IK_SEARCH_URL = f"{IK_API_BASE}/search/"
IK_DOC_URL_FMT = f"{IK_API_BASE}/doc/{{docid}}/"
IK_DOCMETA_URL_FMT = f"{IK_API_BASE}/docmeta/{{docid}}/"

#: Public URL pattern for a document on indiankanoon.org. We use this as
#: the ``source_url`` recorded against each chunk in chromadb so that
#: provenance is human-clickable.
IK_PUBLIC_URL_FMT = "https://indiankanoon.org/doc/{docid}/"

#: Year-tagged queries are built at sync time from
#: :func:`_build_ik_queries` so they shift forward automatically — in
#: 2027 we'll auto-fetch ``"CBDT circular 2027"`` / ``"CBDT circular 2026"``
#: with no source edit. Two pages per query.

#: Pages of search results to pull for each query (0-indexed). 5 pages
#: at 10 rows/page gives 50 candidate rows per query before dedup.
IK_SEARCH_PAGES: tuple[int, ...] = (0, 1, 2, 3, 4)

#: Title-keyword whitelist applied as a secondary filter after the
#: docsource check in :func:`_ik_search`. ``doctypes:laws`` + Union-of-
#: India docsource still surfaces non-income-tax statutes (Waqf
#: Amendment Act, RERA, etc.); requiring at least one of these tokens
#: in the title narrows the keep-set to direct-tax material.
IK_TITLE_KEYWORDS: tuple[str, ...] = (
    "income tax",
    "income-tax",
    "finance act",
    "direct tax",
    "cbdt",
    "tds",
    "tcs",
    "capital gains",
    "assessment",
)

#: Hard cap on the number of new documents we will fetch in a single sync.
MAX_NEW_DOWNLOADS_PER_SYNC = 100

#: Per-doc-type age limit. Documents older than this (by ``publishdate``)
#: are skipped before the expensive full-text fetch. Tuned by document
#: half-life: circulars and notifications go stale fast as new ones
#: amend them. Statutes (the IT Act, IT Rules, any Finance Act) NEVER
#: expire on age — IK reports their ``publishdate`` as the year the
#: parent Act was passed (1961, 1962, ...) but the sections remain
#: current law until explicitly repealed, so dropping them by age
#: would gut the index.
_AGE_LIMIT_DAYS: dict[str, int] = {
    "circular": 365 * 3,
    "notification": 365 * 3,
    "press_release": 365 * 3,
    "cbdt_general": 365 * 2,
}

#: Doc types that are never age-expired regardless of ``publishdate``.
#: See ``_is_too_old`` — these short-circuit to ``False`` before any
#: date arithmetic.
_NEVER_EXPIRE_DOC_TYPES: frozenset[str] = frozenset(
    {"income_tax_act", "income_tax_rules", "finance_act"}
)

#: Fallback age limit for any doc_type not in :data:`_AGE_LIMIT_DAYS`
#: and not in :data:`_NEVER_EXPIRE_DOC_TYPES`.
_DEFAULT_AGE_LIMIT_DAYS = 365 * 3

#: Per-call spacing (seconds). Polite throttle against the API.
API_DELAY_SECONDS = 0.5

#: HTTP timeouts.
IK_TIMEOUT_SECONDS = 60.0

#: User-Agent for outbound API calls.
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 ITaxReplyAgent/1.0"
)

#: Hardcoded supersession pairs. Used by :mod:`rag_embedder` to mark the
#: older title as superseded once both are indexed. Slugs are matched
#: case-insensitively against ``source_url``.
SUPERSESSION_PAIRS: tuple[tuple[str, str], ...] = (
    ("income-tax-act-1961", "income-tax-act-20251"),
    ("income-tax-rules-1962", "income-tax-rule-2026"),
)

# CBDT reference patterns. We try them in order, stopping at the first hit.
_CBDT_REF_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("Circular", re.compile(r"Circular\s*No\.?\s*([\w\-]+/\d{4})", re.IGNORECASE)),
    ("Notification", re.compile(r"Notification\s*No\.?\s*([\w\-]+/\d{4})", re.IGNORECASE)),
    ("Instruction", re.compile(r"Instruction\s*No\.?\s*([\w\-]+/\d{4})", re.IGNORECASE)),
)

log = get_rag_logger()


# ---------------------------------------------------------------------------
# Dedup state (persisted in sync_status.json under "known_urls")
# ---------------------------------------------------------------------------
def _file_key(path: Path) -> str:
    """Stable dedup key for a manually-dropped file: sha256(name|size|mtime)."""
    try:
        st = path.stat()
        sig = f"{path.name}|{st.st_size}|{int(st.st_mtime)}"
    except OSError:
        sig = path.name
    return hashlib.sha256(sig.encode("utf-8")).hexdigest()


def _url_hash(url_or_id: str) -> str:
    """Stable dedup key for a remote document.

    Accepts either a URL string or, for the Indian Kanoon path, the raw
    docid (caller is expected to pass the canonical public URL so the
    hash is stable across implementation changes).
    """
    return hashlib.sha256(url_or_id.strip().encode("utf-8")).hexdigest()


def _load_known_urls() -> set[str]:
    if not RAG_SYNC_STATUS.exists():
        return set()
    try:
        with RAG_SYNC_STATUS.open("r", encoding="utf-8") as f:
            payload = json.load(f)
        known = payload.get("known_urls") or []
        if isinstance(known, list):
            return set(known)
    except (json.JSONDecodeError, OSError):
        pass
    return set()


def _save_known_urls(known: set[str], extra: dict[str, Any] | None = None) -> None:
    current: dict[str, Any] = {}
    if RAG_SYNC_STATUS.exists():
        try:
            with RAG_SYNC_STATUS.open("r", encoding="utf-8") as f:
                current = json.load(f) or {}
        except (json.JSONDecodeError, OSError):
            current = {}
    current["known_urls"] = sorted(known)
    if extra:
        current.update(extra)
    tmp = RAG_SYNC_STATUS.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(current, f, indent=2, ensure_ascii=False)
    tmp.replace(RAG_SYNC_STATUS)


# ---------------------------------------------------------------------------
# CBDT reference parsing
# ---------------------------------------------------------------------------
def parse_cbdt_ref(text: str) -> str | None:
    """Extract a CBDT reference (e.g. ``"Circular No. 8/2013"``) from text."""
    snippet = text[:4096]
    for label, pat in _CBDT_REF_PATTERNS:
        m = pat.search(snippet)
        if m:
            return f"{label} No. {m.group(1)}"
    return None


# ---------------------------------------------------------------------------
# Doc-type classification (used by manual ingest + IK title classifier)
# ---------------------------------------------------------------------------
def _classify_doc_type(path: Path) -> str:
    """Guess the document type from a filename stem."""
    name = path.stem.lower()
    if "press" in name and ("release" in name or "_pr_" in name):
        return "press_release"
    if "circular" in name:
        return "circular"
    if "notification" in name:
        return "notification"
    if "finance" in name:
        return "finance_act"
    if "income-tax-act" in name or "income_tax_act" in name:
        return "income_tax_act"
    if "rule" in name or "rules" in name:
        return "income_tax_rules"
    return "unknown"


def _classify_ik_title(title: str) -> str:
    """Bucket an Indian Kanoon document by its title text.

    Order matters: the most specific Act/Rules signals are checked first
    so that, e.g., "Section 80C in The Income Tax Act, 1961" buckets as
    ``income_tax_act`` rather than the generic fallback. The title is
    whitespace-collapsed before substring matching because IK section
    titles routinely look like ``"The  Income   Tax   Act, 2025"`` —
    without normalisation the ``"income tax act"`` literal would miss.
    """
    t = re.sub(r"\s+", " ", (title or "").lower()).strip()
    if "income tax act" in t or "income-tax act" in t:
        return "income_tax_act"
    if "income tax rules" in t or "income-tax rules" in t:
        return "income_tax_rules"
    if "finance act" in t:
        return "finance_act"
    if "circular" in t:
        return "circular"
    if "notification" in t:
        return "notification"
    return "cbdt_general"


_YEAR_RE = re.compile(r"(19|20)\d{2}")


def _parse_effective_date(filename_or_title: str) -> str:
    m = _YEAR_RE.search(filename_or_title)
    if m:
        return f"{m.group(0)}-01-01"
    return ""


# ---------------------------------------------------------------------------
# Single-file ingestion (validates one local PDF/DOCX/TXT)
# ---------------------------------------------------------------------------
def ingest_local_file(
    path: Path,
    *,
    source_url: str | None = None,
    doc_type_override: str | None = None,
    title_override: str | None = None,
    effective_date_override: str | None = None,
) -> dict[str, Any] | None:
    """Validate one local file and produce an embedder-ready metadata dict.

    Returns ``None`` on any validation failure; never raises.
    """
    if not path.is_file():
        log.warning("ingest_local_file: not a file: %s", path)
        return None

    ext = path.suffix.lower()
    if ext not in SUPPORTED_EXTS:
        log.warning("ingest_local_file: unsupported extension '%s': %s", ext, path.name)
        return None

    try:
        if ext == ".pdf":
            with path.open("rb") as f:
                magic = f.read(5)
            if magic != b"%PDF-":
                log.warning(
                    "ingest_local_file: %s does not start with '%%PDF-' (got %r) — skipping",
                    path.name,
                    magic,
                )
                return None
        elif ext == ".docx":
            with path.open("rb") as f:
                magic = f.read(2)
            if magic != b"PK":
                log.warning("ingest_local_file: %s is not a valid DOCX (zip) — skipping", path.name)
                return None
    except OSError as e:
        log.warning("ingest_local_file: read error on %s: %s", path.name, e)
        return None

    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    title = (title_override or path.stem)[:240]
    return {
        "url": source_url or path.as_uri(),
        "source_url": source_url or path.as_uri(),
        "local_path": str(path),
        "document_type": doc_type_override or _classify_doc_type(path),
        "document_title": title,
        "fetched_at": fetched_at,
        "effective_date": effective_date_override or _parse_effective_date(path.name),
        "is_superseded": False,
        "superseded_by": "",
    }


# ---------------------------------------------------------------------------
# Folder scan (manual drop-folder, recursive)
# ---------------------------------------------------------------------------
def ingest_local_documents(folder: Path) -> dict[str, Any]:
    """Recursively scan ``folder`` for new PDF / DOCX / TXT files and ingest.

    Recursive because Indian Kanoon-fetched ``.txt`` files land under
    ``RAG_DOCS_DIR/<doc_type>/`` subfolders and we want the same scan to
    cover them (with dedup keyed on filename|size|mtime so files that
    were already direct-ingested are skipped).
    """
    folder.mkdir(parents=True, exist_ok=True)
    known = _load_known_urls()
    new_metas: list[dict[str, Any]] = []
    skipped = 0
    errors: list[str] = []

    log.info(
        "ingest_local_documents: scanning %s (recursive; known dedup keys=%d)",
        folder,
        len(known),
    )

    try:
        entries = sorted(p for p in folder.rglob("*") if p.is_file())
    except OSError as e:
        log.warning("ingest_local_documents: cannot walk %s: %s", folder, e)
        return {
            "ingested": 0,
            "skipped": 0,
            "errors": [f"folder unreadable: {e}"],
            "metadata": [],
        }

    for entry in entries:
        if entry.suffix.lower() not in SUPPORTED_EXTS:
            continue

        key = _file_key(entry)
        if key in known:
            skipped += 1
            continue

        meta = ingest_local_file(entry)
        if meta is None:
            errors.append(f"validation failed: {entry.name}")
            continue
        new_metas.append(meta)
        known.add(key)

    _save_known_urls(known)

    log.info(
        "ingest_local_documents: ingested=%d skipped=%d errors=%d",
        len(new_metas),
        skipped,
        len(errors),
    )

    return {
        "ingested": len(new_metas),
        "skipped": skipped,
        "errors": errors,
        "metadata": new_metas,
    }


# ---------------------------------------------------------------------------
# Indian Kanoon API client
# ---------------------------------------------------------------------------
def _read_ik_token() -> str:
    """Return the Indian Kanoon API token from config.json (empty if missing)."""
    try:
        cfg = load_config()
        token = (cfg.get("indiankanoon_token") or "").strip()
        return token
    except Exception as e:
        log.warning("could not read indiankanoon_token: %s", e)
        return ""


def _ik_post(url: str, token: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """POST to an Indian Kanoon endpoint. Returns JSON dict or ``None`` on failure.

    Handles 403 (bad token), 429 (rate limited — one short retry), and
    transport errors. Never raises into the scheduler.
    """
    try:
        import httpx
    except ImportError:
        log.error("httpx not installed — cannot reach Indian Kanoon")
        return None

    headers = {
        "Authorization": f"Token {token}",
        "Accept": "application/json",
        "User-Agent": _UA,
    }
    attempt = 0
    while True:
        attempt += 1
        try:
            with httpx.Client(timeout=IK_TIMEOUT_SECONDS, headers=headers) as client:
                r = client.post(url, data=params or {})
        except Exception as e:
            log.warning("[ik] POST %s failed: %s", url, e)
            return None

        if r.status_code == 403:
            log.error("[ik] 403 — Invalid Indian Kanoon token (rejected at %s)", url)
            return None
        if r.status_code == 429:
            if attempt == 1:
                log.warning("[ik] 429 rate-limited at %s — sleeping 5s before one retry", url)
                time.sleep(5)
                continue
            log.error("[ik] 429 again after retry — giving up on %s", url)
            return None
        if r.status_code != 200:
            log.warning("[ik] %s -> HTTP %s", url, r.status_code)
            return None

        try:
            return r.json()
        except Exception as e:
            log.warning("[ik] %s returned non-JSON: %s", url, e)
            return None


def _is_relevant_ik_row(row: dict[str, Any]) -> bool:
    """Filter IK search rows down to central-government laws.

    IK's ``doctypes:laws`` filter (applied inline at search time) keeps
    judgments out, but still surfaces state-level statutes (Kerala
    Building Tax Act, J&K Constitution, etc.) and the Constitution of
    India itself. We only want Union-of-India material — the field
    ``docsource`` cleanly distinguishes them with the ``"Union of
    India - ..."`` prefix.
    """
    docsource = row.get("docsource", "") or ""
    if docsource and not docsource.startswith("Union of India"):
        return False
    return True


def _ik_search(
    token: str, query: str, page: int, doctypes: str | None = None
) -> list[dict[str, Any]]:
    """Run one search and return the result rows.

    ``doctypes`` is appended **inline** to ``formInput`` as
    ``"<query> doctypes:<bucket>"`` — the IK ``/search/`` endpoint
    ignores the separate POST body field of the same name (verified
    empirically against the live API), but the inline selector inside
    the query string is honoured.

    Accepted bucket values per the IK browse hierarchy:
    ``supremecourt``, ``highcourts``, ``tribunals``, ``judgments``,
    ``laws`` (Central Acts and Rules).

    Rows are then narrowed via :func:`_is_relevant_ik_row` so state Acts
    and the Constitution don't pollute the index.
    """
    form_input = f"{query} doctypes:{doctypes}" if doctypes else query
    params: dict[str, str] = {"formInput": form_input, "pagenum": str(page)}
    payload = _ik_post(IK_SEARCH_URL, token, params=params)
    if not isinstance(payload, dict):
        return []
    rows = payload.get("docs")
    if not isinstance(rows, list):
        return []
    kept: list[dict[str, Any]] = []
    dropped = 0
    for r in rows:
        if not isinstance(r, dict):
            continue
        if not _is_relevant_ik_row(r):
            dropped += 1
            continue
        # Secondary filter: even Union-of-India statutes can be off-topic
        # (Waqf, RERA, etc.). Require a direct-tax keyword in the title.
        # The title MUST be whitespace-collapsed before substring matching
        # — IK section titles routinely contain runs of multiple spaces
        # ("The  Income   Tax   Act, 1961") that otherwise defeat the
        # literal "income tax" keyword.
        title = _strip_html_tags(r.get("title") or "")
        title_l = re.sub(r"\s+", " ", title.lower()).strip()
        if not any(kw in title_l for kw in IK_TITLE_KEYWORDS):
            log.info(
                "[ik] dropped docid=%s reason=unrelated act title=%r",
                r.get("tid"), title[:160],
            )
            dropped += 1
            continue
        kept.append(r)
    log.info(
        "[ik] q=%r page=%d summary: kept=%d dropped=%d total=%d",
        query, page, len(kept), dropped, len(rows),
    )
    return kept


def _ik_docmeta(token: str, docid: str) -> dict[str, Any] | None:
    """Fetch the metadata block for one document."""
    url = IK_DOCMETA_URL_FMT.format(docid=docid)
    payload = _ik_post(url, token)
    return payload if isinstance(payload, dict) else None


def _ik_doc(token: str, docid: str) -> dict[str, Any] | None:
    """Fetch the full-text block for one document."""
    url = IK_DOC_URL_FMT.format(docid=docid)
    payload = _ik_post(url, token)
    return payload if isinstance(payload, dict) else None


# ---------------------------------------------------------------------------
# IK helpers: HTML → text, filename sanitisation, date extraction
# ---------------------------------------------------------------------------
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"[ \t]+")
_BLANK_LINES_RE = re.compile(r"\n\s*\n+")


def _strip_html_tags(text: str) -> str:
    """Strip inline HTML markup from a short string (title, headline, etc.).

    IK search results commonly wrap matched terms in ``<b>...</b>`` tags
    inside the ``title`` field. Without this scrub we end up with
    filenames and chromadb metadata like ``<b>Income</b><b>Tax</b>...``.
    """
    if not text:
        return ""
    try:
        from bs4 import BeautifulSoup

        return BeautifulSoup(text, "lxml").get_text(separator=" ").strip()
    except Exception:
        return _HTML_TAG_RE.sub(" ", text).strip()


def _strip_html_to_text(html: str) -> str:
    """Convert IK's HTML ``doc`` payload into readable plain text.

    Prefers BeautifulSoup when available (clean line breaks, entity
    decoding); falls back to a regex strip when bs4 is unavailable.
    """
    if not html:
        return ""
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "lxml")
        # Drop scripts/styles outright — IK rarely embeds them but be safe.
        for el in soup(["script", "style"]):
            el.decompose()
        text = soup.get_text("\n", strip=True)
    except Exception:
        text = _HTML_TAG_RE.sub(" ", html)

    text = _WHITESPACE_RE.sub(" ", text)
    text = _BLANK_LINES_RE.sub("\n\n", text).strip()
    return text


def _sanitize_filename_part(s: str, *, max_len: int = 80) -> str:
    """Filesystem-safe, whitespace-collapsed, max-length stub for a filename."""
    s = re.sub(r"[^\w\-]+", "_", (s or "").strip())
    s = s.strip("._-")
    return s[:max_len] or "doc"


def _parse_ik_date(meta: dict[str, Any]) -> str:
    """Pull an ISO date out of an IK docmeta block.

    IK exposes the publication date under various keys depending on the
    document source (``publishdate``, ``docdate``, ``date``). We try
    each and accept anything that looks like a year or full ISO date.
    """
    for k in ("publishdate", "docdate", "date"):
        v = meta.get(k)
        if not v:
            continue
        v = str(v).strip()
        if re.match(r"^\d{4}-\d{2}-\d{2}", v):
            return v[:10]
        m = _YEAR_RE.search(v)
        if m:
            return f"{m.group(0)}-01-01"
    return ""


def _build_ik_queries() -> tuple[dict[str, str], ...]:
    """Construct the IK search queries for this sync.

    Each query is a ``{"q": ..., "doctypes": ...}`` pair. We deliberately
    restrict ``doctypes`` to ``"laws"`` — Indian Kanoon's only useful
    bucket for our purposes — because IK does not index CBDT circulars
    or notifications as standalone documents. (CBDT material is fetched
    via :func:`scrape_taxguru` instead.) The actual ``doctypes:<bucket>``
    selector is appended **inline** to ``formInput`` at the call site;
    the separate POST body field is ignored by the API.

    Year-anchored queries use :func:`datetime.now`, so coverage rolls
    forward automatically each January.
    """
    current_year = datetime.now().year
    last_year = current_year - 1
    return (
        {"q": "Income Tax Act 2025", "doctypes": "laws"},
        {"q": "Income Tax Rules 2026", "doctypes": "laws"},
        {"q": f"Finance Act {current_year}", "doctypes": "laws"},
        {"q": f"Finance Act {last_year}", "doctypes": "laws"},
        {"q": "Income Tax Act", "doctypes": "laws"},
        # Topic-anchored sweeps — each pulls section-level results that
        # the broad "Income Tax Act" query may not surface within its
        # first 5 pages.
        {"q": "Income Tax Act 1961 assessment", "doctypes": "laws"},
        {"q": "Income Tax Act 2025 capital gains", "doctypes": "laws"},
        {"q": "Income Tax Act 2025 deductions", "doctypes": "laws"},
        {"q": "Income Tax Act 2025 TDS", "doctypes": "laws"},
        {"q": "Income Tax Act 1961 penalties", "doctypes": "laws"},
    )


def _is_too_old(doc_type: str, iso_date: str) -> bool:
    """True if ``iso_date`` is older than the freshness limit for ``doc_type``.

    Statutes — the IT Act, IT Rules, any Finance Act — short-circuit
    to ``False`` regardless of the date: IK stamps them with the year
    the parent Act was passed (e.g. 1961 for the IT Act) but the
    sections remain current law until explicitly repealed.

    Undated documents (empty / unparseable ``iso_date``) are allowed
    through — without a date we can't judge freshness, and dropping
    every undated row would discard otherwise-good results.
    """
    if doc_type in _NEVER_EXPIRE_DOC_TYPES:
        return False
    if not iso_date:
        return False
    try:
        published = datetime.fromisoformat(iso_date[:10]).date()
    except ValueError:
        return False
    cutoff_days = _AGE_LIMIT_DAYS.get(doc_type, _DEFAULT_AGE_LIMIT_DAYS)
    age_days = (datetime.now().date() - published).days
    return age_days > cutoff_days


# ---------------------------------------------------------------------------
# IK orchestrator
# ---------------------------------------------------------------------------
def scrape_indian_kanoon() -> dict[str, Any]:
    """Search IK for the configured queries, download each new doc as ``.txt``.

    Returns::

        {
          "downloaded":  [pdf_meta, ...],   # direct-ingested metadata blocks
          "errors":      [str, ...],
          "sources_ok":  [str, ...],
          "sources_bad": [str, ...],
        }
    """
    token = _read_ik_token()
    if not token:
        log.warning(
            "indiankanoon_token missing or empty — skipping API scrape; "
            "manual drop-folder ingest still active"
        )
        return {
            "downloaded": [],
            "errors": ["indiankanoon_token missing"],
            "sources_ok": [],
            "sources_bad": [IK_API_BASE],
        }

    queries = _build_ik_queries()
    log.info("[ik] starting scrape — %d queries x %d pages", len(queries), len(IK_SEARCH_PAGES))

    # ----- Phase B1: collect doc IDs across all queries -------------------
    seen_results: dict[str, dict[str, Any]] = {}
    query_failures: list[str] = []

    for q_spec in queries:
        query = q_spec["q"]
        doctypes = q_spec.get("doctypes") or None
        for page in IK_SEARCH_PAGES:
            rows = _ik_search(token, query, page, doctypes=doctypes)
            time.sleep(API_DELAY_SECONDS)
            if not rows:
                # _ik_search logs the failure; we only mark a hard failure
                # if BOTH pages of a query returned nothing.
                continue
            for row in rows:
                tid = row.get("tid")
                if tid is None:
                    continue
                docid = str(tid)
                seen_results.setdefault(docid, row)
            log.info(
                "[ik] q=%r doctypes=%s page=%d -> %d rows",
                query, doctypes or "-", page, len(rows),
            )
        if not any(
            seen_results for _ in (None,)
        ):  # cheap "any results so far" guard
            pass

    if not seen_results:
        log.warning("[ik] no search results across any query — API/token may be unhealthy")
        return {
            "downloaded": [],
            "errors": ["no search results from Indian Kanoon"],
            "sources_ok": [],
            "sources_bad": [IK_API_BASE],
        }

    log.info("[ik] collected %d unique docids across all queries", len(seen_results))

    # ----- Phase B2: dedup against known_urls and download ----------------
    known = _load_known_urls()
    downloaded: list[dict[str, Any]] = []
    errors: list[str] = []
    budget = MAX_NEW_DOWNLOADS_PER_SYNC

    for docid, search_row in seen_results.items():
        if budget <= 0:
            log.info("[ik] download budget exhausted, stopping")
            break

        public_url = IK_PUBLIC_URL_FMT.format(docid=docid)
        url_key = _url_hash(public_url)
        if url_key in known:
            continue

        meta_json = _ik_docmeta(token, docid)
        time.sleep(API_DELAY_SECONDS)
        if meta_json is None:
            errors.append(f"docmeta fetch failed: {docid}")
            continue

        # IK wraps matched terms in <b> tags in both search results and
        # docmeta — scrub before classification, filename derivation, and
        # chromadb metadata so we never persist raw markup.
        raw_title = (
            meta_json.get("title") or search_row.get("title") or f"doc-{docid}"
        )
        title = _strip_html_tags(raw_title) or f"doc-{docid}"
        doc_type = _classify_ik_title(title)
        # ``effective_date`` doubles as both the scrape-time freshness gate
        # input and the chromadb metadata field consumed by supersession
        # detection. Embedder-side supersession will compare these dates
        # so the newer doc always wins; here we just plumb the value.
        effective_date = _parse_ik_date(meta_json) or _parse_effective_date(title)

        # Freshness gate. Skip stale docs BEFORE paying for the full
        # doc-body fetch — saves one API round trip + 0.5 s throttle per
        # rejected document.
        if _is_too_old(doc_type, effective_date):
            log.info(
                "[ik] skipped docid=%s title=%r reason=too old (%s)",
                docid, title[:80], effective_date,
            )
            continue

        doc_json = _ik_doc(token, docid)
        time.sleep(API_DELAY_SECONDS)
        if doc_json is None:
            errors.append(f"doc fetch failed: {docid}")
            continue

        html = doc_json.get("doc") or ""
        text = _strip_html_to_text(html)
        if not text:
            errors.append(f"empty body: {docid}")
            continue

        # Save as RAG_DOCS_DIR/<doc_type>/<docid>_<title>.txt
        save_dir = RAG_DOCS_DIR / doc_type
        save_dir.mkdir(parents=True, exist_ok=True)
        fname = f"{docid}_{_sanitize_filename_part(title)}.txt"
        save_path = save_dir / fname
        try:
            save_path.write_text(text, encoding="utf-8")
        except OSError as e:
            log.warning("[ik] could not write %s: %s", save_path, e)
            errors.append(f"write failed: {docid}: {e}")
            continue

        meta = ingest_local_file(
            save_path,
            source_url=public_url,
            doc_type_override=doc_type,
            title_override=title,
            effective_date_override=effective_date,
        )
        if meta is None:
            errors.append(f"validation failed after save: {save_path.name}")
            continue

        downloaded.append(meta)
        # Mark BOTH the URL hash AND the file_key as known so subsequent
        # ingest_local_documents() rescans skip this file and we don't
        # re-pull the doc from the API.
        known.add(url_key)
        known.add(_file_key(save_path))
        budget -= 1

        log.info(
            "[ik] saved docid=%s type=%s title=%r path=%s",
            docid,
            doc_type,
            title[:80],
            save_path.name,
        )

    try:
        _save_known_urls(known)
    except Exception as e:
        log.warning("[ik] could not persist known_urls: %s", e)

    log.info(
        "[ik] scrape done — fetched=%d errors=%d (budget left=%d)",
        len(downloaded),
        len(errors),
        budget,
    )

    return {
        "downloaded": downloaded,
        "errors": errors + query_failures,
        "sources_ok": [IK_API_BASE] if downloaded or not errors else [],
        "sources_bad": [IK_API_BASE] if errors and not downloaded else [],
    }


# ---------------------------------------------------------------------------
# incometaxindia.gov.in /news/ direct-PDF scraper
# ---------------------------------------------------------------------------
#: Base URL for the income-tax department's notification + circular PDFs.
#: Note: this domain is fronted by Akamai. The React SPA routes (``/``,
#: ``/circulars`` etc.) are bot-gated and return 403, but the static PDFs
#: under ``/news/`` are reportedly served without the same protection.
#: Validate from your deployment IP if Phase B comes back empty.
INCOMETAX_BASE = "https://incometaxindia.gov.in"
INCOMETAX_NEWS_BASE = f"{INCOMETAX_BASE}/news"

#: Highest serial number to probe per (year, doc_type) combination.
INCOMETAX_MAX_N = 50

#: Stop probing a (year, doc_type) once we've seen this many consecutive
#: 404s — the assumption is that the source publishes serial numbers
#: contiguously, so a run of misses means we've walked off the end.
INCOMETAX_MAX_CONSECUTIVE_404S = 5

#: Hard cap on new PDFs fetched per sync run (across both years and types).
INCOMETAX_MAX_DOCS_PER_SYNC = 100

#: Per-request spacing (seconds). Polite throttle against the source.
INCOMETAX_DELAY_SECONDS = 1.0


def _incometax_url_variants(doc_type: str, n: int, year: int) -> list[str]:
    """Build the candidate URL variants to probe for one (doc_type, n, year).

    The income-tax department's publishing convention is inconsistent for
    single-digit serial numbers — some files are listed as ``-no-1-`` and
    others as ``-no-01-``. We try the unpadded form first (the more common
    one in recent years) and only add the zero-padded fallback when ``n``
    is < 10.
    """
    base = f"{INCOMETAX_NEWS_BASE}/{doc_type}-no-{n}-{year}.pdf"
    variants = [base]
    if n < 10:
        variants.append(f"{INCOMETAX_NEWS_BASE}/{doc_type}-no-0{n}-{year}.pdf")
    return variants


def scrape_incometax_pdfs() -> dict[str, Any]:
    """Probe ``incometaxindia.gov.in/news/`` for direct CBDT PDFs.

    For each (year, doc_type) combination in ``{current_year, last_year}
    × {notification, circular}``, walks ``N = 1..50`` and HEAD-probes the
    canonical URL pattern plus a zero-padded fallback for ``N < 10``.
    On HEAD 200 the body is fetched, magic-byte checked, saved under
    ``RAG_DOCS_DIR/<doc_type>/<filename>.pdf``, and direct-ingested.
    Five consecutive misses for a combination stop the walk for that
    combination — we never traverse the full 1..50 once the source has
    run dry.

    Gated by the ``incometax_pdf_scraper_enabled`` flag in ``config.json``
    so the entire phase can be disabled without removing the function.
    """
    try:
        cfg = load_config()
    except Exception as e:
        log.warning("[incometax] could not read config: %s", e)
        cfg = {}
    if not bool(cfg.get("incometax_pdf_scraper_enabled", True)):
        log.info("[incometax] disabled by config flag — skipping phase")
        return {"downloaded": [], "errors": [], "sources_ok": [], "sources_bad": []}

    try:
        import httpx
    except ImportError:
        log.warning("[incometax] httpx missing — phase disabled")
        return {
            "downloaded": [],
            "errors": ["httpx missing"],
            "sources_ok": [],
            "sources_bad": [INCOMETAX_BASE],
        }

    known = _load_known_urls()
    downloaded: list[dict[str, Any]] = []
    errors: list[str] = []
    budget = INCOMETAX_MAX_DOCS_PER_SYNC

    current_year = datetime.now().year
    years = (current_year, current_year - 1)
    doc_types = ("notification", "circular")

    headers = {"User-Agent": _UA, "Accept": "application/pdf,*/*"}

    log.info("[incometax] starting scrape — years=%s types=%s", years, doc_types)

    try:
        with httpx.Client(
            headers=headers, timeout=60.0, follow_redirects=True
        ) as client:
            for year in years:
                for doc_type in doc_types:
                    if budget <= 0:
                        break
                    misses = 0
                    for n in range(1, INCOMETAX_MAX_N + 1):
                        if budget <= 0:
                            break
                        if misses >= INCOMETAX_MAX_CONSECUTIVE_404S:
                            log.info(
                                "[incometax] %d/%s: %d consecutive misses at N=%d, "
                                "stopping this combination",
                                year, doc_type, misses, n,
                            )
                            break

                        hit_url: str | None = None
                        for url in _incometax_url_variants(doc_type, n, year):
                            try:
                                r = client.head(url, timeout=15.0)
                            except Exception as e:
                                log.warning("[incometax] HEAD %s failed: %s", url, e)
                                time.sleep(INCOMETAX_DELAY_SECONDS)
                                continue
                            time.sleep(INCOMETAX_DELAY_SECONDS)
                            if r.status_code == 200:
                                hit_url = url
                                break
                            # Anything else (404, 403, 5xx) → try next variant.

                        if hit_url is None:
                            misses += 1
                            continue
                        misses = 0

                        url_key = _url_hash(hit_url)
                        if url_key in known:
                            # Already ingested in a prior sync; skip without
                            # spending the GET.
                            continue

                        try:
                            g = client.get(hit_url)
                        except Exception as e:
                            errors.append(f"GET failed: {hit_url}: {e}")
                            time.sleep(INCOMETAX_DELAY_SECONDS)
                            continue
                        time.sleep(INCOMETAX_DELAY_SECONDS)

                        if g.status_code != 200:
                            errors.append(f"GET {hit_url} -> HTTP {g.status_code}")
                            continue
                        if not g.content.startswith(b"%PDF-"):
                            errors.append(f"non-PDF body at {hit_url}")
                            continue

                        save_dir = RAG_DOCS_DIR / doc_type
                        save_dir.mkdir(parents=True, exist_ok=True)
                        fname = hit_url.rsplit("/", 1)[-1]
                        save_path = save_dir / fname
                        try:
                            save_path.write_bytes(g.content)
                        except OSError as e:
                            errors.append(f"write failed: {save_path}: {e}")
                            continue

                        meta = ingest_local_file(
                            save_path,
                            source_url=hit_url,
                            doc_type_override=doc_type,
                            title_override=save_path.stem,
                        )
                        if meta is None:
                            errors.append(
                                f"validation failed after save: {save_path.name}"
                            )
                            continue

                        downloaded.append(meta)
                        known.add(url_key)
                        known.add(_file_key(save_path))
                        budget -= 1
                        log.info("[incometax] saved %s", hit_url)
    except Exception as e:
        log.exception("[incometax] outer client crashed")
        errors.append(f"client crashed: {e}")

    try:
        _save_known_urls(known)
    except Exception as e:
        log.warning("[incometax] could not persist known_urls: %s", e)

    log.info(
        "[incometax] done — fetched=%d errors=%d budget_left=%d",
        len(downloaded), len(errors), budget,
    )

    return {
        "downloaded": downloaded,
        "errors": errors,
        "sources_ok": [INCOMETAX_BASE] if downloaded else [],
        "sources_bad": [INCOMETAX_BASE] if errors and not downloaded else [],
    }




# ---------------------------------------------------------------------------
# One-time chromadb cleanup helpers
# ---------------------------------------------------------------------------
def _cleanup_unrelated_chunks() -> None:
    """Drop chunks whose ``document_title`` contains ``"waqf"`` (case-insensitive).

    Runs at the top of every :func:`scrape_all_sources` call. The first
    run after the Waqf-blocking title filter was added (see
    :data:`IK_TITLE_KEYWORDS`) does the real work; subsequent runs are
    no-ops because the chunks are already gone and the keyword filter
    prevents new ones from landing. Chunks are grouped by ``source_url``
    so we log one tidy line per document instead of one per chunk.
    """
    try:
        from services import rag_embedder

        collection = rag_embedder._open_collection()
    except Exception as e:
        log.warning("[cleanup] could not open chromadb: %s", e)
        return

    try:
        rows = collection.get(include=["metadatas"])
    except Exception as e:
        log.warning("[cleanup] collection.get failed: %s", e)
        return

    ids: list[str] = list(rows.get("ids") or [])
    metas: list[Any] = list(rows.get("metadatas") or [])

    by_doc: dict[str, dict[str, Any]] = {}
    for cid, m in zip(ids, metas):
        if not isinstance(m, dict):
            continue
        title = m.get("document_title") or ""
        if "waqf" not in title.lower():
            continue
        key = m.get("source_url") or cid
        d = by_doc.setdefault(key, {"title": title, "ids": []})
        d["ids"].append(cid)

    if not by_doc:
        return

    for info in by_doc.values():
        try:
            collection.delete(ids=info["ids"])
            log.info(
                "[cleanup] removed %d chunks for unrelated doc: %s",
                len(info["ids"]), info["title"],
            )
        except Exception as e:
            log.warning("[cleanup] delete failed for %r: %s", info["title"], e)


# ---------------------------------------------------------------------------
# Orchestrator: scrape_all_sources
# ---------------------------------------------------------------------------
def scrape_all_sources() -> dict[str, Any]:
    """Run one full sync pass and return the aggregated status.

    Phases:

    * **A — manual ingest.** Top-level + recursive scan of ``RAG_DOCS_DIR``.
    * **B — incometaxindia.gov.in.** CBDT circulars / notifications via
      direct-PDF URL probing under ``/news/`` (gated by the
      ``incometax_pdf_scraper_enabled`` config flag).
    * **C — Indian Kanoon.** Income Tax Act / Rules / Finance Act via the
      ``doctypes:laws`` filter, narrowed to ``"Union of India"`` docsources.
    * **D — rescan.** Final pass over ``RAG_DOCS_DIR`` to pick up anything
      that bypassed direct-ingest in phases B/C.

    Return shape (preserved for the scheduler)::

        {
          "downloaded":  [pdf_meta, ...],
          "errors":      [str, ...],
          "sources_ok":  [str, ...],
          "sources_bad": [str, ...],
        }
    """
    errors: list[str] = []
    sources_ok: list[str] = []
    sources_bad: list[str] = []
    downloaded: list[dict[str, Any]] = []

    # ----- One-time chromadb cleanup --------------------------------------
    # Idempotent: deletes Waqf-and-friends chunks left over from before
    # the secondary keyword filter (IK_TITLE_KEYWORDS) was added. After
    # the first pass this is effectively a no-op.
    try:
        _cleanup_unrelated_chunks()
    except Exception as e:
        log.exception("cleanup pass crashed")
        errors.append(f"cleanup crashed: {e}")

    # ----- Phase A: manual drop-folder ingest -----------------------------
    log.info("scrape_all_sources: phase A — manual ingest from %s", RAG_DOCS_DIR)
    try:
        manual = ingest_local_documents(RAG_DOCS_DIR)
        downloaded.extend(manual["metadata"])
        errors.extend(manual["errors"])
        sources_ok.append(str(RAG_DOCS_DIR))
    except Exception as e:
        log.exception("manual ingest crashed")
        errors.append(f"manual ingest crashed: {e}")
        sources_bad.append(str(RAG_DOCS_DIR))

    # ----- Phase B: incometaxindia.gov.in /news/ direct-PDF probe ---------
    log.info("scrape_all_sources: phase B — incometaxindia.gov.in /news/")
    try:
        it = scrape_incometax_pdfs()
        downloaded.extend(it["downloaded"])
        errors.extend(it["errors"])
        sources_ok.extend(it["sources_ok"])
        sources_bad.extend(it["sources_bad"])
    except Exception as e:
        log.exception("incometax scrape crashed")
        errors.append(f"incometax crashed: {e}")
        sources_bad.append(INCOMETAX_BASE)

    # ----- Phase C: Indian Kanoon API scrape (acts + rules, Union of India)
    log.info("scrape_all_sources: phase C — Indian Kanoon API")
    try:
        ik = scrape_indian_kanoon()
        downloaded.extend(ik["downloaded"])
        errors.extend(ik["errors"])
        sources_ok.extend(ik["sources_ok"])
        sources_bad.extend(ik["sources_bad"])
    except Exception as e:
        log.exception("indian kanoon scrape crashed")
        errors.append(f"indian kanoon crashed: {e}")
        sources_bad.append(IK_API_BASE)

    # ----- Phase D: rescan to catch any files that bypassed direct-ingest -
    log.info("scrape_all_sources: phase D — rescan drop folder")
    try:
        rescan = ingest_local_documents(RAG_DOCS_DIR)
        # Anything new here is a true miss from phase B (rare — typically
        # only happens if direct-ingest failed after the file landed on disk).
        if rescan["metadata"]:
            log.info("[rescan] picked up %d file(s) missed by direct ingest", len(rescan["metadata"]))
        downloaded.extend(rescan["metadata"])
        errors.extend(rescan["errors"])
    except Exception as e:
        log.exception("rescan crashed")
        errors.append(f"rescan crashed: {e}")

    log.info(
        "scrape_all_sources done — downloaded=%d ok=%d bad=%d errors=%d",
        len(downloaded),
        len(sources_ok),
        len(sources_bad),
        len(errors),
    )

    return {
        "downloaded": downloaded,
        "errors": errors,
        "sources_ok": sources_ok,
        "sources_bad": sources_bad,
    }


# ---------------------------------------------------------------------------
# Helpers consumed elsewhere
# ---------------------------------------------------------------------------
def known_url_count() -> int:
    """Number of distinct dedup keys recorded across all sync runs."""
    return len(_load_known_urls())


def list_local_pdfs() -> Iterable[Path]:
    """Yield every PDF under ``RAG_DOCS_DIR`` (recursive).

    Note: the post-IK pipeline writes ``.txt`` files, not PDFs. This
    function is kept for the embedder's :func:`reembed_local_pdfs`
    helper which only handles PDFs; ``.txt`` files are picked up via
    :func:`ingest_local_documents` instead.
    """
    if not RAG_DOCS_DIR.exists():
        return iter(())
    return RAG_DOCS_DIR.rglob("*.pdf")
