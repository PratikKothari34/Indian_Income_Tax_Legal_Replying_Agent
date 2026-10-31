//! `/rag/*` — corpus status, manual sync, document listing, reindex.
//!
//! The heavy operations are fire-and-forget: a sync can run for minutes
//! and a reindex re-embeds the whole corpus, so both return immediately
//! and progress is observed through `GET /rag/status`.
//!
//! Route paths and response shapes match v1 exactly, including the detail
//! that **`/rag/documents` returns a bare array** while `/rag/status`
//! returns an object. An installed frontend parses both.

use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;

use crate::paths;
use crate::services::{rag_embedder, rag_scheduler};

#[derive(Debug, Serialize)]
pub struct RagStatusResponse {
    // v1's fields, flattened in by hand rather than with #[serde(flatten)]
    // so the wire shape is visible here.
    pub last_sync: Option<String>,
    pub docs_total: usize,
    pub docs_added_last_run: usize,
    pub last_sync_status: String,
    pub errors: Vec<String>,
    pub next_scheduled_sync: Option<String>,
    /// When false and `last_sync_status == "never"`, the frontend shows
    /// "run sync once with internet to download the embedding model".
    pub embedding_model_available: bool,
    pub chunks_total: usize,
    pub superseded_docs: usize,
    /// v2 addition: lets the UI disable the sync button while one runs
    /// instead of firing a request that is silently skipped.
    pub sync_in_progress: bool,
}

pub async fn rag_status() -> Json<RagStatusResponse> {
    let base = rag_scheduler::get_status();
    Json(RagStatusResponse {
        last_sync: base.last_sync,
        docs_total: base.docs_total,
        docs_added_last_run: base.docs_added_last_run,
        last_sync_status: base.last_sync_status,
        errors: base.errors,
        next_scheduled_sync: rag_scheduler::next_scheduled_sync_iso(),
        embedding_model_available: rag_embedder::is_model_available(),
        chunks_total: rag_embedder::collection_size().await,
        superseded_docs: rag_embedder::superseded_docs_count().await,
        sync_in_progress: rag_scheduler::is_running(),
    })
}

#[derive(Debug, Serialize)]
pub struct StartedResponse {
    pub status: &'static str,
    pub message: &'static str,
}

/// `POST /rag/sync` — kick off a sync in the background.
///
/// The lock inside `run_sync` means a second press is skipped, not queued,
/// so the button is safe to mash.
pub async fn rag_sync_trigger() -> Json<StartedResponse> {
    tokio::spawn(async move {
        rag_scheduler::run_sync().await;
    });
    Json(StartedResponse {
        status: "started",
        message: "Sync started in background",
    })
}

/// `GET /rag/documents` — a **bare array**, as in v1.
pub async fn rag_documents() -> Json<Vec<rag_embedder::DocumentRow>> {
    Json(rag_embedder::list_documents().await)
}

/// `POST /rag/reindex` — wipe the store and re-embed every local document.
///
/// Destructive, and unauthenticated for a browser-less caller — safe only
/// because the server binds to 127.0.0.1 and the origin guard requires the
/// per-install token from any page-originated request. If the bind address
/// ever changes, this needs its own auth gate before shipping.
pub async fn rag_reindex() -> Json<StartedResponse> {
    tokio::spawn(async move {
        // Exclusive: a sync landing mid-reindex deletes `sync_status-rs.json`
        // under the other job and costs the whole corpus a re-download. The
        // guard also makes `sync_in_progress` true for a reindex, which is
        // what the UI polls to know a job is running.
        let ran = rag_scheduler::run_exclusive(async {
            if let Err(e) = rag_embedder::clear_collection().await {
                tracing::warn!("[reindex] could not clear the vector store: {e}");
            }
            // Clearing the store leaves `known_urls` stale: the next sync would
            // skip every already-fetched document and add nothing back.
            rag_scheduler::clear_dedup_cache();
            let chunks = rag_embedder::reembed_local_pdfs().await;
            let marked = rag_embedder::detect_supersessions().await;
            tracing::info!("[reindex] done - {chunks} chunk(s), {marked} superseded");
        })
        .await;
        if ran.is_none() {
            tracing::info!("[reindex] skipped - another corpus job is already in progress");
        }
    });
    Json(StartedResponse {
        status: "started",
        message: "Reindex started in background",
    })
}

#[derive(Debug, Serialize)]
pub struct DocsFolderResponse {
    pub path: String,
    pub exists: bool,
}

/// `GET /rag/docs-folder` — where the user drops circulars by hand.
pub async fn rag_docs_folder() -> Json<DocsFolderResponse> {
    let dir = paths::rag_docs_dir();
    // Created on read: the UI shows this path as a destination, and
    // pointing a user at a folder that does not exist yet is a dead end.
    let _ = std::fs::create_dir_all(&dir);
    Json(DocsFolderResponse {
        path: dir.display().to_string(),
        exists: dir.is_dir(),
    })
}

/// `GET /rag/query` — retrieval without generation.
///
/// Not in v1. It exists because a citation the model produced is only
/// trustworthy if the chunk behind it can be inspected, and the frontend's
/// statutory margin shows exactly that. It is read-only and cheap.
#[derive(Debug, serde::Deserialize)]
pub struct QueryParams {
    pub q: String,
    #[serde(default = "default_n")]
    pub n: usize,
}

fn default_n() -> usize {
    5
}

pub async fn rag_query(
    axum::extract::Query(params): axum::extract::Query<QueryParams>,
) -> Result<Json<Vec<rag_embedder::Hit>>, (StatusCode, Json<serde_json::Value>)> {
    if params.q.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "detail": "'q' is required." })),
        ));
    }
    // Clamped: an unbounded `n` would scan and sort the whole corpus into
    // one response body.
    let n = params.n.clamp(1, 25);
    Ok(Json(rag_embedder::query(params.q.trim(), n).await))
}
