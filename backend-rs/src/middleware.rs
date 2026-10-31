//! Request guards. Ported from v1 `main.py`, same rules, same order.
//!
//! The backend binds 127.0.0.1 only, which stops a remote host reaching it
//! but does **not** stop a page in the user's own browser: any site they
//! visit can `fetch("http://127.0.0.1:8000/generate")`. The response is
//! blocked by CORS, but the request still ran — and `/rag/reindex` wipes a
//! corpus whether or not the attacker reads the reply. Three layers answer
//! that:
//!
//! 1. **Host** must be loopback. A DNS name resolving to 127.0.0.1
//!    (the classic rebinding trick) carries its own hostname in the Host
//!    header and is rejected here.
//! 2. **A mutating request carrying a browser `Origin`** must either come
//!    from a trusted dev origin or present the per-install bearer token.
//!    A non-browser caller (curl, the Tauri shell) sends no `Origin` and
//!    is unaffected.
//! 3. **The CORS allow-list** keeps a disallowed origin from reading a
//!    reply.
//!
//! The dev origins are trusted, so a frontend that omits the token still
//! works under `npm run dev` and 403s only once packaged. The shell must
//! therefore attach `X-ITax-Auth` unconditionally — that asymmetry is the
//! single likeliest cause of "works in dev, breaks installed".

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use subtle::ConstantTimeEq;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::state::AppState;

/// Hostnames the Host header may carry.
const ALLOWED_HOSTNAMES: [&str; 2] = ["127.0.0.1", "localhost"];

/// 10 MiB, matching v1's `MAX_GENERATE_BODY_BYTES`.
///
/// A notice's extracted text plus history is tens of kilobytes. This is
/// not a tuning knob — it is the ceiling that stops one request from
/// buffering a gigabyte into memory before any handler sees it.
pub const MAX_GENERATE_BODY_BYTES: usize = 10 * 1024 * 1024;

/// Origins a browser page may legitimately hold while driving this
/// backend: the Vite dev server, the Tauri dev host, and the backend's own
/// port range.
fn allowed_origins() -> Vec<String> {
    let mut out = Vec::new();
    for host in ["localhost", "127.0.0.1"] {
        out.push(format!("http://{host}"));
        // 5174 is v2's Vite port (5173 is v1's, so the two can run side
        // by side); 1420/1430 are Tauri's dev defaults.
        for port in [3000, 1420, 1430, 5173, 5174, 8000, 8001, 8002, 8003] {
            out.push(format!("http://{host}:{port}"));
        }
    }
    // Tauri does not serve the packaged app over a normal origin, and the
    // spelling is per-platform -- all three must be here or the app silently
    // cannot reach its own backend.
    //
    // `http://tauri.localhost` is the Windows one, and it is the one that
    // matters on this project: WebView2 serves the bundled app from it. Its
    // absence is invisible to every curl test, because curl does not enforce
    // CORS -- the backend answers 200, the webview throws `TypeError: Failed
    // to fetch`, and the UI reports the backend as down while it is up.
    out.push("http://tauri.localhost".into());
    out.push("https://tauri.localhost".into());
    out.push("tauri://localhost".into());
    out
}

/// Origins trusted to mutate **without** presenting the token.
///
/// Deliberately narrower than [`allowed_origins`]: being allowed to read a
/// reply and being allowed to wipe the corpus are different privileges.
///
/// Only the dev-server origins are here, and only because a frontend run
/// under `npm run dev` has no way to fetch the per-install token. The
/// packaged app does -- `api.ts` attaches `X-ITax-Auth` to every non-GET
/// unconditionally -- so the `tauri.localhost` spellings are **not** in this
/// list even though they are in the CORS list.
///
/// That omission is the point. `http://tauri.localhost` is a real hostname
/// that resolves on this machine, so treating it as trusted would let any
/// page able to present that Origin mutate state with no token at all, and
/// `/rag/reindex` destroys a corpus whether or not the attacker can read the
/// response. The token costs the real app nothing and closes that door.
///
/// `"null"` is deliberately absent too: a sandboxed iframe or a `file://`
/// page sends `Origin: null`, and that is exactly the untrusted case.
/// v1 allowed `"null"` through CORS for reading but excluded it here too.
fn trusted_browser_origins() -> Vec<String> {
    let mut out = Vec::new();
    for host in ["localhost", "127.0.0.1"] {
        // 5174 is v2's Vite port (5173 is v1's); 1420/1430 are Tauri's dev
        // defaults. No bare-host or backend-port entry: nothing legitimately
        // mutates from one without a token.
        for port in [1420, 1430, 5173, 5174] {
            out.push(format!("http://{host}:{port}"));
        }
    }
    out
}

pub fn cors_layer() -> CorsLayer {
    let mut origins: Vec<header::HeaderValue> = allowed_origins()
        .iter()
        .filter_map(|o| o.parse().ok())
        .collect();
    // A `file://` page reads as `Origin: null`. Allowed for reads so a
    // locally opened HTML test page works; never trusted for mutation.
    if let Ok(v) = "null".parse() {
        origins.push(v);
    }
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::ACCEPT,
            header::AUTHORIZATION,
            header::HeaderName::from_static("x-itax-auth"),
        ])
        // No cookies are used, and allowing credentials would forbid the
        // wildcard-free list above from ever being relaxed safely.
        .allow_credentials(false)
}

fn deny(code: StatusCode, detail: &str) -> Response {
    (code, Json(serde_json::json!({ "detail": detail }))).into_response()
}

/// Strip the port from a Host header value: `127.0.0.1:8000` -> `127.0.0.1`.
///
/// IPv6 arrives bracketed (`[::1]:8000`), so splitting on the last colon
/// would corrupt it; handle the bracketed form first.
fn hostname_of(host: &str) -> String {
    let host = host.trim();
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next().unwrap_or("").to_string();
    }
    match host.rsplit_once(':') {
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) => name.to_string(),
        _ => host.to_string(),
    }
}

fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

fn is_mutating(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

/// Constant-time token comparison.
///
/// A byte-by-byte `==` leaks the matching prefix length through timing,
/// which is enough to recover a token one byte at a time from a local
/// process that can make many requests. The length check is unavoidably
/// non-constant-time and harmless — a token's length is not secret.
fn token_matches(expected: &str, provided: &str) -> bool {
    if expected.is_empty() {
        // No token on disk means the install is not yet provisioned.
        // Fail closed: an empty expectation must never match.
        return false;
    }
    let a = expected.as_bytes();
    let b = provided.as_bytes();
    a.len() == b.len() && a.ct_eq(b).into()
}

/// Layer 1 + 2: loopback Host, and token-or-trusted-origin for mutations.
pub async fn local_origin_guard(
    State(state): State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let headers = req.headers().clone();
    let method = req.method().clone();

    // A missing Host is an HTTP/1.1 protocol error for any real client,
    // and HTTP/2 synthesises one from :authority, so treat absence as
    // hostile rather than defaulting it to loopback.
    let Some(host) = header_str(&headers, "host") else {
        return deny(StatusCode::FORBIDDEN, "Missing Host header.");
    };
    let hostname = hostname_of(&host);
    if !ALLOWED_HOSTNAMES.contains(&hostname.as_str()) {
        tracing::warn!("rejected a request with Host '{host}'");
        return deny(
            StatusCode::FORBIDDEN,
            "This backend only accepts requests addressed to localhost.",
        );
    }

    if is_mutating(&method) {
        // A mutation needs a trusted browser origin OR a valid token.
        //
        // The token check used to live inside `if let Some(origin)`, which
        // meant a request carrying NO Origin header skipped authentication
        // altogether. Browsers always send Origin cross-origin, so the
        // browser path looked covered -- but curl and every other
        // non-browser local process omits it by default, and so reached
        // /generate, /upload, /save-docx and the /rag mutations with no
        // credential. Confirmed against the running backend: an
        // unauthenticated POST /generate returned 200 and ran inference.
        //
        // An absent Origin is not a trusted origin. It must present a token
        // like any other untrusted caller.
        let origin = header_str(&headers, "origin");
        let trusted = origin
            .as_deref()
            .is_some_and(|o| trusted_browser_origins().iter().any(|t| t == o));

        if !trusted {
            let provided = header_str(&headers, "x-itax-auth").unwrap_or_default();
            if !token_matches(state.auth_token(), &provided) {
                tracing::warn!(
                    "rejected a {method} from origin {:?} with no valid auth token",
                    origin.as_deref().unwrap_or("<none>")
                );
                return deny(
                    StatusCode::FORBIDDEN,
                    "A valid X-ITax-Auth header is required for this request.",
                );
            }
        }
    }

    next.run(req).await
}

/// Layer 3: the 10 MiB body cap on `/generate`.
///
/// `Content-Length` is checked first so an oversized declared body is
/// rejected without reading it. A chunked request declares no length, so
/// the body is materialised under the cap — `to_bytes` stops at the limit
/// rather than buffering the whole stream, which is the point.
pub async fn generate_body_cap(req: Request<Body>, next: Next) -> Response {
    let declared = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());

    if let Some(len) = declared {
        if len > MAX_GENERATE_BODY_BYTES {
            return deny(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Request body exceeds the 10 MiB limit.",
            );
        }
        return next.run(req).await;
    }

    // Chunked transfer: no declared length to trust.
    let (parts, body) = req.into_parts();
    let bytes = match to_bytes(body, MAX_GENERATE_BODY_BYTES).await {
        Ok(b) => b,
        Err(_) => {
            return deny(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Request body exceeds the 10 MiB limit.",
            )
        }
    };
    next.run(Request::from_parts(parts, Body::from(bytes))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_port_is_stripped_from_the_host_header() {
        assert_eq!(hostname_of("127.0.0.1:8000"), "127.0.0.1");
        assert_eq!(hostname_of("localhost:8003"), "localhost");
        assert_eq!(hostname_of("localhost"), "localhost");
        assert_eq!(hostname_of(" 127.0.0.1 "), "127.0.0.1");
    }

    #[test]
    fn an_ipv6_host_is_not_mangled_by_the_port_split() {
        // Splitting on the last colon would turn this into "[::1".
        assert_eq!(hostname_of("[::1]:8000"), "::1");
        assert_eq!(hostname_of("[::1]"), "::1");
    }

    #[test]
    fn a_rebinding_hostname_is_rejected() {
        // The whole point of checking Host rather than the socket: an
        // attacker's DNS name resolving to 127.0.0.1 still carries its
        // own name here.
        for host in [
            "evil.example.com",
            "evil.example.com:8000",
            "127.0.0.1.evil.com",
            "localhost.evil.com",
        ] {
            let name = hostname_of(host);
            assert!(
                !ALLOWED_HOSTNAMES.contains(&name.as_str()),
                "{host} must not pass"
            );
        }
    }

    #[test]
    fn only_mutating_methods_are_gated() {
        assert!(is_mutating(&Method::POST));
        assert!(is_mutating(&Method::PUT));
        assert!(is_mutating(&Method::PATCH));
        assert!(is_mutating(&Method::DELETE));
        assert!(!is_mutating(&Method::GET));
        assert!(!is_mutating(&Method::HEAD));
        assert!(!is_mutating(&Method::OPTIONS));
    }

    #[test]
    fn an_empty_expected_token_never_matches() {
        // An unprovisioned install must fail closed, not open.
        assert!(!token_matches("", ""));
        assert!(!token_matches("", "anything"));
    }

    #[test]
    fn token_comparison_is_exact() {
        assert!(token_matches("abc123", "abc123"));
        assert!(!token_matches("abc123", "abc124"));
        assert!(!token_matches("abc123", "abc12"));
        assert!(!token_matches("abc123", "abc1234"));
    }

    #[test]
    fn the_dev_origins_are_trusted_but_a_null_origin_is_not() {
        let trusted = trusted_browser_origins();
        assert!(trusted.iter().any(|o| o == "http://localhost:5173"));
        assert!(trusted.iter().any(|o| o == "http://localhost:1420"));
        // A sandboxed iframe or file:// page sends this.
        assert!(!trusted.iter().any(|o| o == "null"));
        assert!(!trusted.iter().any(|o| o == "https://evil.example.com"));
    }

    #[test]
    fn the_packaged_origins_may_read_but_may_not_mutate_untokened() {
        // The two lists must not be the same list. Allowing an origin to
        // read a reply is not the same as letting it mutate with no token,
        // and `trusted_browser_origins` used to just call `allowed_origins`
        // -- so the CORS fix that added `http://tauri.localhost` silently
        // handed it token-free write access to `/rag/reindex`.
        //
        // The packaged app always sends `X-ITax-Auth` (see `api.ts`), so it
        // loses nothing by being absent here.
        let trusted = trusted_browser_origins();
        for spelling in [
            "http://tauri.localhost",
            "https://tauri.localhost",
            "tauri://localhost",
        ] {
            assert!(
                allowed_origins().iter().any(|o| o == spelling),
                "{spelling} must still be allowed to read"
            );
            assert!(
                !trusted.iter().any(|o| o == spelling),
                "{spelling} must not mutate without a token"
            );
        }
        // Nor may the backend's own port range, which a page could hold
        // after any navigation to it.
        assert!(!trusted.iter().any(|o| o == "http://127.0.0.1:8000"));
    }

    /// The guard itself, end to end -- not the origin lists.
    ///
    /// Every other test here asserts over `allowed_origins()` and
    /// `trusted_browser_origins()`. That is why a real bypass survived: the
    /// token check sat inside `if let Some(origin)`, so a mutation with NO
    /// Origin header skipped authentication completely, and not one
    /// list-shaped assertion could see it. curl sends no Origin by default.
    ///
    /// Anything that changes `local_origin_guard` must keep these four
    /// cases, which are the whole contract:
    ///   no Origin + no token  -> 403   (the regression)
    ///   no Origin + token     -> pass  (curl, scripts, the packaged app)
    ///   bad Origin + no token -> 403
    ///   trusted Origin        -> pass  (the dev server)
    #[tokio::test]
    async fn a_mutation_without_an_origin_still_needs_a_token() {
        use axum::{routing::post, Router};
        use tower::ServiceExt;

        const TOKEN: &str = "0123456789abcdef0123456789abcdef";

        let state = AppState::new(Default::default(), TOKEN.to_string());
        let app = Router::new()
            .route("/generate", post(|| async { "ok" }))
            .layer(axum::middleware::from_fn_with_state(
                state,
                local_origin_guard,
            ));

        // Builds a POST with the given optional Origin and token headers.
        let send = |origin: Option<&'static str>, token: Option<&'static str>| {
            let app = app.clone();
            async move {
                let mut b = Request::builder()
                    .method(Method::POST)
                    .uri("/generate")
                    .header("host", "127.0.0.1:8003");
                if let Some(o) = origin {
                    b = b.header("origin", o);
                }
                if let Some(t) = token {
                    b = b.header("x-itax-auth", t);
                }
                app.oneshot(b.body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status()
            }
        };

        // The regression. curl and every non-browser caller land here.
        assert_eq!(
            send(None, None).await,
            StatusCode::FORBIDDEN,
            "a mutation with no Origin and no token must be rejected"
        );

        // The same caller, authenticated, must still work.
        assert_eq!(
            send(None, Some(TOKEN)).await,
            StatusCode::OK,
            "a valid token must authorise a request that sends no Origin"
        );

        // An untrusted origin without a token stays rejected.
        assert_eq!(
            send(Some("http://evil.example"), None).await,
            StatusCode::FORBIDDEN
        );

        // A wrong token is not a token.
        assert_eq!(send(None, Some("wrong")).await, StatusCode::FORBIDDEN);

        // The dev server mutates without one, as designed.
        assert_eq!(
            send(Some("http://localhost:5174"), None).await,
            StatusCode::OK
        );
    }

    #[test]
    fn the_v2_vite_dev_port_is_allowed() {
        // frontend-v2/vite.config.ts pins 5174 and tauri.conf.json's devUrl
        // matches it. If this drops out of the list, every mutating request
        // 403s under `npm run dev` while the packaged build keeps working -
        // the hardest version of this bug to diagnose.
        assert!(allowed_origins().iter().any(|o| o == "http://127.0.0.1:5174"));
        assert!(trusted_browser_origins()
            .iter()
            .any(|o| o == "http://localhost:5174"));
    }

    #[test]
    fn every_tauri_origin_spelling_is_allowed() {
        // Tauri spells the packaged app's origin differently per platform,
        // and the Windows one is the one this project ships on.
        //
        // This is a regression test for a real bug: only the https:// and
        // tauri:// spellings were listed, so on Windows every fetch from the
        // packaged app was blocked by CORS. The backend answered 200 to curl
        // throughout -- curl does not enforce CORS -- while the webview got
        // `TypeError: Failed to fetch` and the UI reported "Not running"
        // against a backend that was up. Nothing short of an origin-aware
        // check catches it.
        let origins = allowed_origins();
        for spelling in [
            "http://tauri.localhost",  // Windows (WebView2)
            "https://tauri.localhost", // Linux / custom protocol
            "tauri://localhost",       // macOS
        ] {
            assert!(
                origins.iter().any(|o| o == spelling),
                "missing Tauri origin spelling: {spelling}"
            );
        }
    }

    #[test]
    fn the_cors_list_covers_every_backend_fallback_port() {
        // These must stay in step with paths::PORT_FALLBACK_CHAIN, or the
        // frontend breaks only on a machine where 8000 was taken.
        let origins = allowed_origins();
        for port in crate::paths::PORT_FALLBACK_CHAIN {
            assert!(
                origins.iter().any(|o| o == &format!("http://127.0.0.1:{port}")),
                "port {port} missing from the CORS list"
            );
        }
    }
}
