//! Shared handler state.
//!
//! Three things every route needs: the config, one pooled inference
//! client, and the per-install auth token.
//!
//! The config is held behind a lock rather than cloned at boot because the
//! Settings panel rewrites `config-rs.json` while the server runs; a
//! snapshot taken at startup would serve a stale llama port or a revoked
//! Indian Kanoon token until the next restart.

use std::sync::Arc;

use tokio::sync::RwLock;

use crate::config::{self, AppConfig};
use crate::services::llama_client::LlamaClient;

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Inner>,
    /// The inference client. Holds pooled connections, so it is created
    /// once and shared — a fresh client per request means a fresh TLS/TCP
    /// handshake per request.
    pub llama: Arc<LlamaClient>,
}

struct Inner {
    config: RwLock<AppConfig>,
    auth_token: String,
}

impl AppState {
    pub fn new(config: AppConfig, auth_token: String) -> Self {
        Self {
            inner: Arc::new(Inner {
                config: RwLock::new(config),
                auth_token,
            }),
            llama: Arc::new(LlamaClient::new()),
        }
    }

    /// A snapshot of the current config.
    ///
    /// Cloned rather than handed out as a guard: a handler holding a read
    /// guard across an `await` on a 15-minute inference call would block
    /// every config write for the duration.
    pub async fn config(&self) -> AppConfig {
        self.inner.config.read().await.clone()
    }

    /// Re-read `config-rs.json` from disk into the shared state.
    pub async fn reload_config(&self) -> AppConfig {
        let fresh = config::load();
        *self.inner.config.write().await = fresh.clone();
        fresh
    }

    pub fn auth_token(&self) -> &str {
        &self.inner.auth_token
    }
}
