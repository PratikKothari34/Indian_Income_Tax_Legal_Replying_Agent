//! llama.cpp inference client. Replaces `backend/services/ollama_client.py`.
//!
//! # Why HTTP and not FFI
//!
//! `llama-server` exposes an OpenAI-compatible `/v1/chat/completions`, so the
//! integration is a typed HTTP call with no C++ linkage, no bindgen step, and
//! no rebuild when the user upgrades llama.cpp. Binding libllama directly
//! would pin this crate to one llama.cpp ABI and make a CUDA build a
//! compile-time concern rather than the user's own install choice.
//!
//! # Two deadlines, deliberately
//!
//! The probe path backs `/health`, which the shell polls to decide whether the
//! backend is alive. A server that accepts the connection and never answers
//! would stall an untimed probe forever. Generation legitimately runs for
//! minutes on a 14B model and must not inherit that short deadline.
//!
//! # Model selection
//!
//! Ported from v1: a complex notice (revision, search/seizure, reassessment,
//! penalty, transfer pricing...) or one over 3000 characters routes to the
//! fallback/reasoning model when one is configured. A caller-pinned model
//! always wins — power users and tests need to bypass the heuristic.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::prompts::{ChatMessage, Role};
use crate::config::AppConfig;

/// Deadline for metadata probes. Generous for a busy server, short enough
/// that `/health` always returns.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Backstop for a chat completion against a wedged server — not a
/// performance target. A 14B model on CPU is slow.
pub const CHAT_TIMEOUT: Duration = Duration::from_secs(900);

/// Keywords that flip a call from "standard" to "complex" and route it to the
/// reasoning model. Curated for notices that need careful chain-of-thought.
const COMPLEX_TASK_KEYWORDS: [&str; 26] = [
    "263", "revision", "search", "seizure", "raid",
    "penalty", "prosecution", "undisclosed", "black money",
    "transfer pricing", "international", "dtaa", "treaty",
    "reassessment", "148", "153c", "276", "277", "278",
    "survey", "271", "concealment", "bogus", "accommodation",
    "144c", "92ca",
];

/// Long notices bundle multiple issues and benefit from the slower model.
const COMPLEX_TASK_LENGTH_THRESHOLD: usize = 3000;

#[derive(Debug, Error)]
pub enum LlamaError {
    #[error("llama-server is not reachable at {url}: {source}")]
    Unreachable { url: String, #[source] source: reqwest::Error },
    #[error("llama-server returned {status}: {body}")]
    Status { status: u16, body: String },
    #[error("llama-server returned an empty completion")]
    Empty,
    #[error("no GGUF model is configured; set llama_model_path in settings")]
    NoModel,
    #[error("malformed response from llama-server: {0}")]
    Malformed(String),
}

// --- wire types for the OpenAI-compatible surface ---

#[derive(Serialize)]
struct WireMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    messages: Vec<WireMessage<'a>>,
    temperature: f32,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<&'a str>,
    /// llama-server caps generation at a small default otherwise, which
    /// truncates a full legal letter mid-paragraph.
    n_predict: i32,
    #[serde(rename = "cache_prompt")]
    cache_prompt: bool,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize)]
struct Choice {
    #[serde(default)]
    message: Option<ResponseMessage>,
}

#[derive(Deserialize)]
struct ResponseMessage {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Deserialize)]
struct PropsResponse {
    #[serde(default)]
    model_path: Option<String>,
    #[serde(default)]
    default_generation_settings: Option<serde_json::Value>,
}

fn role_str(role: &Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
    }
}

/// True when the last user turn looks like a high-stakes proceeding.
pub fn is_complex_task(messages: &[ChatMessage]) -> bool {
    let text = messages
        .iter()
        .rev()
        .find(|m| m.role == Role::User)
        .map(|m| m.content.as_str())
        .unwrap_or("");
    if text.is_empty() {
        return false;
    }
    if text.len() > COMPLEX_TASK_LENGTH_THRESHOLD {
        return true;
    }
    let low = text.to_lowercase();
    COMPLEX_TASK_KEYWORDS.iter().any(|kw| low.contains(kw))
}

#[derive(Debug, Clone, Serialize)]
pub struct LlamaHealth {
    pub server_running: bool,
    /// Model file the server reports having loaded.
    pub loaded_model: Option<String>,
    pub base_url: String,
    pub error: Option<String>,
    /// Something answered on this port and it is **not** llama-server.
    ///
    /// Worth its own flag rather than a prose error, because the two
    /// remedies are opposite: a sick llama-server wants restarting, while a
    /// foreign occupant wants the *port changed*. Restarting into an
    /// occupied port just reproduces the failure.
    pub port_occupied_by_other: bool,
}

pub struct LlamaClient {
    probe: reqwest::Client,
    chat: reqwest::Client,
}

impl LlamaClient {
    pub fn new() -> Self {
        // Two clients, not one, because the call sites have opposite
        // deadlines. Connection pools are cheap; a shared timeout is not.
        Self {
            probe: reqwest::Client::builder()
                .timeout(PROBE_TIMEOUT)
                .build()
                .expect("probe client"),
            chat: reqwest::Client::builder()
                .timeout(CHAT_TIMEOUT)
                .build()
                .expect("chat client"),
        }
    }

    /// Probe reachability and which model is loaded. Never fails hard — any
    /// error lands in the `error` field so `/health` always answers.
    pub async fn health(&self, cfg: &AppConfig) -> LlamaHealth {
        let base = cfg.llama_base_url();
        let mut health = LlamaHealth {
            server_running: false,
            loaded_model: None,
            base_url: base.clone(),
            error: None,
            port_occupied_by_other: false,
        };
        match self.probe.get(format!("{base}/props")).send().await {
            Ok(resp) if resp.status().is_success() => {
                health.server_running = true;
                if let Ok(props) = resp.json::<PropsResponse>().await {
                    health.loaded_model = props.model_path.or_else(|| {
                        props
                            .default_generation_settings
                            .as_ref()
                            .and_then(|v| v.get("model"))
                            .and_then(|v| v.as_str())
                            .map(str::to_string)
                    });
                }
            }
            Ok(resp) => {
                // /props is absent on some builds; /health is the fallback.
                let status = resp.status().as_u16();
                match self.probe.get(format!("{base}/health")).send().await {
                    Ok(h) if h.status().is_success() => health.server_running = true,
                    Ok(h) => {
                        // Both endpoints answered and neither is llama-server's.
                        // A real llama-server serves at least one of them, so
                        // this is a different program holding the port --
                        // on Windows, often a service that will take it again
                        // on every boot. Say that, because "returned 404" sends
                        // the user looking for a broken model instead.
                        health.port_occupied_by_other = true;
                        health.error = Some(format!(
                            "Something other than llama-server is listening on {base}                              (/props returned {status}, /health returned {}).                              Change llama_port in Settings to a free port.",
                            h.status().as_u16()
                        ));
                    }
                    Err(_) => health.error = Some(format!("llama-server returned {status}")),
                }
            }
            Err(e) => health.error = Some(e.to_string()),
        }
        health
    }

    /// Run a chat completion, falling back to the secondary model on failure.
    ///
    /// Returns `(reply_text, model_used)`. `model_used` is the GGUF path or
    /// alias the server actually served, so the session record is accurate.
    pub async fn chat(
        &self,
        cfg: &AppConfig,
        messages: &[ChatMessage],
        model_override: Option<&str>,
        temperature: f32,
        auto_select: bool,
    ) -> Result<(String, String), LlamaError> {
        let primary = cfg.llama_model_path.trim();
        let fallback = cfg.llama_fallback_model_path.trim();

        // Candidate order. A pinned override always comes first.
        let mut candidates: Vec<String> = Vec::new();
        fn push(m: &str, list: &mut Vec<String>) {
            let m = m.trim();
            if !m.is_empty() && !list.iter().any(|existing| existing == m) {
                list.push(m.to_string());
            }
        }
        if let Some(m) = model_override {
            push(m, &mut candidates);
        } else if auto_select && !fallback.is_empty() && is_complex_task(messages) {
            tracing::info!("[model-select] complex notice -> fallback/reasoning model");
            push(fallback, &mut candidates);
        }
        push(primary, &mut candidates);
        push(fallback, &mut candidates);

        // An empty candidate list is still valid: a llama-server started with
        // a model on its command line serves whatever it loaded, and omitting
        // `model` from the request is the correct way to ask for it.
        if candidates.is_empty() {
            return self.try_one(cfg, messages, None, temperature).await;
        }

        let mut last_err: Option<LlamaError> = None;
        for candidate in &candidates {
            match self.try_one(cfg, messages, Some(candidate), temperature).await {
                Ok(ok) => return Ok(ok),
                Err(e) => {
                    tracing::warn!("model {candidate} failed: {e}");
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or(LlamaError::NoModel))
    }

    async fn try_one(
        &self,
        cfg: &AppConfig,
        messages: &[ChatMessage],
        model: Option<&str>,
        temperature: f32,
    ) -> Result<(String, String), LlamaError> {
        let base = cfg.llama_base_url();
        let url = format!("{base}/v1/chat/completions");
        let wire: Vec<WireMessage> = messages
            .iter()
            .map(|m| WireMessage { role: role_str(&m.role), content: &m.content })
            .collect();
        let body = ChatRequest {
            messages: wire,
            temperature,
            stream: false,
            model,
            // -1 means "until EOS or context is full". A legal reply runs long
            // and a positive cap truncates it mid-letter.
            n_predict: -1,
            cache_prompt: true,
        };

        let resp = self
            .chat
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|source| LlamaError::Unreachable { url: url.clone(), source })?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            // Truncated: a server error page should not land whole in a log.
            let body: String = body.chars().take(500).collect();
            return Err(LlamaError::Status { status: status.as_u16(), body });
        }

        let parsed: ChatResponse = resp
            .json()
            .await
            .map_err(|e| LlamaError::Malformed(e.to_string()))?;
        let content = parsed
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message)
            .and_then(|m| m.content)
            .unwrap_or_default();
        let content = content.trim().to_string();
        if content.is_empty() {
            return Err(LlamaError::Empty);
        }
        let used = model
            .map(str::to_string)
            .or(parsed.model)
            .unwrap_or_else(|| "llama.cpp".to_string());
        Ok((content, used))
    }
}

impl Default for LlamaClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::prompts::ChatMessage;

    use crate::config::AppConfig;

    /// Stand up a server on a real port that answers, but is not
    /// llama-server: every path 404s, exactly like the Windows service that
    /// holds 8080 on the author's machine. Returns the port it bound.
    ///
    /// A real listener rather than a mock, because the bug being pinned here
    /// is about what happens over an actual socket.
    async fn spawn_foreign_server() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind an ephemeral port");
        let port = listener.local_addr().expect("local addr").port();
        let app = axum::Router::new();  // no routes: everything is a 404
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        port
    }

    fn cfg_on_port(port: u16) -> AppConfig {
        AppConfig {
            llama_host: "127.0.0.1".into(),
            llama_port: port,
            ..AppConfig::default()
        }
    }

    #[tokio::test]
    async fn a_foreign_program_on_the_port_is_named_not_reported_as_a_404() {
        let port = spawn_foreign_server().await;
        let health = LlamaClient::new().health(&cfg_on_port(port)).await;

        assert!(!health.server_running, "a 404-everything server is not llama-server");
        assert!(
            health.port_occupied_by_other,
            "an occupant that answers but serves neither /props nor /health              must be flagged as foreign"
        );

        // The remedy must be in the message. "llama-server returned 404"
        // sends the user hunting a broken model; the port is the real cause.
        let msg = health.error.expect("an occupied port must explain itself");
        assert!(
            msg.contains("llama_port"),
            "the message must name the setting to change, got: {msg}"
        );
        assert!(
            !msg.starts_with("llama-server returned"),
            "must not blame llama-server for a port it never held, got: {msg}"
        );
    }

    #[tokio::test]
    async fn nothing_listening_is_unreachable_not_a_foreign_occupant() {
        // Bind then drop, so the port is near-certainly free and unused.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let health = LlamaClient::new().health(&cfg_on_port(port)).await;
        assert!(!health.server_running);
        assert!(
            !health.port_occupied_by_other,
            "a closed port is not an occupied one -- conflating them would              tell the user to change a port that is already free"
        );
    }

    #[test]
    fn complex_keywords_route_to_reasoning_model() {
        let msgs = vec![ChatMessage::user("Notice u/s 148 for reassessment")];
        assert!(is_complex_task(&msgs));
        let msgs = vec![ChatMessage::user("Notice regarding transfer pricing adjustment")];
        assert!(is_complex_task(&msgs));
    }

    #[test]
    fn ordinary_short_notice_is_not_complex() {
        let msgs = vec![ChatMessage::user("Intimation u/s 143(1) mismatch in TDS")];
        assert!(!is_complex_task(&msgs));
    }

    #[test]
    fn long_notice_is_complex_regardless_of_keywords() {
        let msgs = vec![ChatMessage::user("a".repeat(COMPLEX_TASK_LENGTH_THRESHOLD + 1))];
        assert!(is_complex_task(&msgs));
    }

    #[test]
    fn complexity_reads_the_user_turn_not_the_system_prompt() {
        // The system prompt mentions 148 and 271; that must not make every
        // request "complex".
        let msgs = vec![
            ChatMessage::system(crate::services::prompts::SYSTEM_PROMPT),
            ChatMessage::user("Please draft a short reply."),
        ];
        assert!(!is_complex_task(&msgs));
    }

    #[test]
    fn no_user_turn_is_not_complex() {
        assert!(!is_complex_task(&[ChatMessage::system("x")]));
    }
}
