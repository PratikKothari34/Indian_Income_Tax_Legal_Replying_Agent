//! The Tauri commands behind `window.localAgent`.
//!
//! One command per v1 Electron IPC channel, same semantics, same return
//! shapes. `src/lib/bridge.ts` maps the camelCase renderer method names onto
//! these snake_case command names.

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Manager, State};

use crate::backend::{self, BackendState};
use crate::config::{self, AppConfig};
use crate::paths;
use crate::sessions;

#[derive(Debug, Serialize)]
pub struct OkResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl OkResult {
    fn ok() -> Self {
        Self { ok: true, error: None }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self { ok: false, error: Some(msg.into()) }
    }
}

#[derive(Debug, Serialize)]
pub struct SuccessResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SuccessResult {
    fn ok() -> Self {
        Self { success: true, error: None }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self { success: false, error: Some(msg.into()) }
    }
}

/// Reveal the folder containing a generated reply.
///
/// The resolved folder must sit inside the base dir. An out-of-tree path is
/// rejected and the output dir is opened instead — the v1 behaviour, so a
/// stale session pointing somewhere odd still does something sensible rather
/// than handing an arbitrary path to the OS shell.
#[tauri::command]
pub fn open_output_folder(app: tauri::AppHandle, output_file: Option<String>) -> OkResult {
    let fallback = paths::output_dir();
    let base = paths::shell_base_dir();

    let target = match output_file.as_deref().filter(|s| !s.is_empty()) {
        None => fallback.clone(),
        Some(raw) => {
            let folder = std::path::Path::new(raw)
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| fallback.clone());
            // Canonicalise where possible so `..` segments and symlinks are
            // resolved before the containment check. A path that does not
            // exist cannot be canonicalised, so fall back to the raw form —
            // is_within still rejects it unless it is genuinely under base.
            let resolved = folder.canonicalize().unwrap_or(folder);
            let base_resolved = base.canonicalize().unwrap_or_else(|_| base.clone());
            if paths::is_within(&base_resolved, &resolved) {
                resolved
            } else {
                paths::log_line(&format!(
                    "open_output_folder: rejected path outside base dir: {}",
                    resolved.display()
                ));
                fallback.clone()
            }
        }
    };

    let _ = std::fs::create_dir_all(&target);
    match reveal(&app, &target) {
        Ok(()) => OkResult::ok(),
        Err(e) => OkResult::err(e),
    }
}

#[tauri::command]
pub fn open_logs_folder(app: tauri::AppHandle) -> OkResult {
    let dir = paths::appdata_logs();
    let _ = std::fs::create_dir_all(&dir);
    match reveal(&app, &dir) {
        Ok(()) => OkResult::ok(),
        Err(e) => OkResult::err(e),
    }
}

/// Open a directory in the system file manager.
fn reveal(app: &tauri::AppHandle, path: &std::path::Path) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_sessions() -> Vec<sessions::SessionSummary> {
    sessions::list_sessions()
}

/// Read one session. Errors (rather than returning a default) on an invalid
/// id, matching v1 — the renderer treats a rejection as "cannot open".
#[tauri::command]
pub fn read_session(session_id: String) -> Result<serde_json::Value, String> {
    sessions::read_session(&session_id)
}

#[tauri::command]
pub fn delete_session(session_id: String) -> SuccessResult {
    match sessions::delete_session(&session_id) {
        Ok(()) => SuccessResult::ok(),
        Err(e) => SuccessResult::err(e),
    }
}

/// The config, with the Indian Kanoon token **masked**. The real token never
/// crosses the bridge.
#[tauri::command]
pub fn get_config() -> serde_json::Value {
    let cfg = config::read_config();
    let mut value = serde_json::to_value(&cfg).unwrap_or_else(|_| json!({}));
    if let Some(map) = value.as_object_mut() {
        map.insert(
            "indiankanoon_token".into(),
            json!(config::mask_token(&cfg.indiankanoon_token)),
        );
    }
    value
}

#[derive(Debug, Default, Deserialize)]
pub struct ConfigPatch {
    pub llama_host: Option<String>,
    pub llama_port: Option<u16>,
    pub llama_server_path: Option<String>,
    pub llama_model_path: Option<String>,
    pub llama_fallback_model_path: Option<String>,
    pub llama_ctx_size: Option<u32>,
    pub llama_gpu_layers: Option<u32>,
    pub backend_port: Option<u16>,
    pub indiankanoon_token: Option<String>,
    pub incometax_pdf_scraper_enabled: Option<bool>,
    pub rag_sync_schedule: Option<String>,
    pub run_at_startup: Option<bool>,
    pub system_tray: Option<bool>,
    pub keep_awake: Option<bool>,
    pub default_temperature: Option<f32>,
    pub always_save_docx: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct SaveConfigResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_port: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<serde_json::Value>,
}

/// Validate, persist, and restart the backend so the new config takes effect.
///
/// The token handling here is the part that must not regress: the renderer
/// only ever saw the mask, so an incoming value equal to the mask of the
/// stored token means "unchanged" and the stored token is kept.
#[tauri::command]
pub fn save_config(
    state: State<'_, BackendState>,
    next: ConfigPatch,
) -> SaveConfigResult {
    let current = config::read_config();
    let mut merged = AppConfig {
        llama_host: next.llama_host.unwrap_or(current.llama_host.clone()),
        llama_port: next.llama_port.unwrap_or(current.llama_port),
        llama_server_path: next
            .llama_server_path
            .unwrap_or(current.llama_server_path.clone()),
        llama_model_path: next
            .llama_model_path
            .unwrap_or(current.llama_model_path.clone()),
        llama_fallback_model_path: next
            .llama_fallback_model_path
            .unwrap_or(current.llama_fallback_model_path.clone()),
        llama_ctx_size: next.llama_ctx_size.unwrap_or(current.llama_ctx_size),
        llama_gpu_layers: next.llama_gpu_layers.unwrap_or(current.llama_gpu_layers),
        backend_port: next.backend_port.unwrap_or(current.backend_port),
        indiankanoon_token: next
            .indiankanoon_token
            .clone()
            .unwrap_or(current.indiankanoon_token.clone()),
        incometax_pdf_scraper_enabled: next
            .incometax_pdf_scraper_enabled
            .unwrap_or(current.incometax_pdf_scraper_enabled),
        rag_sync_schedule: next
            .rag_sync_schedule
            .unwrap_or(current.rag_sync_schedule.clone()),
        run_at_startup: next.run_at_startup.unwrap_or(current.run_at_startup),
        system_tray: next.system_tray.unwrap_or(current.system_tray),
        keep_awake: next.keep_awake.unwrap_or(current.keep_awake),
        default_temperature: next
            .default_temperature
            .unwrap_or(current.default_temperature),
        always_save_docx: next.always_save_docx.unwrap_or(current.always_save_docx),
    };

    // The mask round-trip. Without this, saving any unrelated setting writes
    // the mask over the live token and destroys it.
    if let Some(incoming) = next.indiankanoon_token.as_deref() {
        if incoming == config::mask_token(&current.indiankanoon_token) {
            merged.indiankanoon_token = current.indiankanoon_token.clone();
        }
    }

    // The backend port is NOT a free choice, and accepting one was a way to
    // brick the install with no route back. The renderer reaches the backend
    // over `fetch`, and the Tauri CSP's `connect-src` (`tauri.conf.json`)
    // allows exactly `127.0.0.1:8000`-`8003` -- the same four ports as
    // `paths::PORT_FALLBACK_CHAIN`. A backend moved to 9000 starts and
    // answers perfectly well; the renderer is then blocked by its own CSP
    // from ever talking to it, including the Settings panel that would put
    // the port back. The only recovery is hand-editing config.json.
    //
    // So the three places agree or the app is broken: this check, the CSP,
    // and the fallback chain. The panel no longer offers the field at all.
    if !backend::PORT_FALLBACK_CHAIN.contains(&u32::from(merged.backend_port)) {
        let allowed = backend::PORT_FALLBACK_CHAIN
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return SaveConfigResult {
            success: false,
            error: Some(format!(
                "The backend port must be one of {allowed}. Other ports are blocked by the app's own content-security policy."
            )),
            backend_port: None,
            config: None,
        };
    }
    if !(1024..=65535).contains(&merged.llama_port) {
        return SaveConfigResult {
            success: false,
            error: Some("The model server port must be between 1024 and 65535.".into()),
            backend_port: None,
            config: None,
        };
    }
    if merged.backend_port == merged.llama_port {
        return SaveConfigResult {
            success: false,
            error: Some("The backend and llama-server ports must be different.".into()),
            backend_port: None,
            config: None,
        };
    }
    // `is_finite` first: NaN fails every comparison, so a bare range check
    // would let it through and hand llama.cpp a sampler value that poisons
    // the whole generation rather than erroring.
    if !merged.default_temperature.is_finite()
        || !(0.0..=1.0).contains(&merged.default_temperature)
    {
        return SaveConfigResult {
            success: false,
            error: Some("The default temperature must be between 0 and 1.".into()),
            backend_port: None,
            config: None,
        };
    }
    if !config::is_valid_cron(&merged.rag_sync_schedule) {
        return SaveConfigResult {
            success: false,
            error: Some(
                "The sync schedule needs 5 cron fields, like \"0 12 * * *\" for daily at noon."
                    .into(),
            ),
            backend_port: None,
            config: None,
        };
    }

    if let Err(e) = config::write_config(&merged) {
        return SaveConfigResult {
            success: false,
            error: Some(format!("Could not save settings: {e}")),
            backend_port: None,
            config: None,
        };
    }

    // Restart so the backend picks up the new port / config.
    backend::kill(&state);
    let port = backend::ensure_running(&state, &merged).ok();

    // Echo back masked — never return the real token.
    let mut echoed = serde_json::to_value(&merged).unwrap_or_else(|_| json!({}));
    if let Some(map) = echoed.as_object_mut() {
        map.insert(
            "indiankanoon_token".into(),
            json!(config::mask_token(&merged.indiankanoon_token)),
        );
    }

    SaveConfigResult {
        success: true,
        error: None,
        backend_port: port.or(Some(state.port())),
        config: Some(echoed),
    }
}

#[tauri::command]
pub fn get_backend_port(state: State<'_, BackendState>) -> u32 {
    state.port()
}

/// The per-install auth token the renderer attaches as `X-ITax-Auth`.
///
/// Read lazily on every call: the file only exists once the backend has
/// booted, and it does not change within a session. Returns `""` when absent
/// so the renderer can still mount and show a waiting state.
#[tauri::command]
pub fn get_backend_auth() -> String {
    std::fs::read_to_string(paths::auth_token_path())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

#[derive(Debug, Deserialize)]
pub struct DesktopSettings {
    pub run_at_startup: bool,
    pub system_tray: bool,
    pub keep_awake: bool,
}

/// Apply the desktop-integration toggles.
///
/// Autostart is applied by writing the Run key; the tray and keep-awake flags
/// are persisted and take effect on the next launch. They are stored in
/// `config.json` so the setting survives a restart.
#[tauri::command]
pub fn apply_desktop_settings(
    app: tauri::AppHandle,
    settings: DesktopSettings,
) -> SuccessResult {
    let mut cfg = config::read_config();
    cfg.run_at_startup = settings.run_at_startup;
    cfg.system_tray = settings.system_tray;
    cfg.keep_awake = settings.keep_awake;
    if let Err(e) = config::write_config(&cfg) {
        return SuccessResult::err(format!("Could not save settings: {e}"));
    }

    if let Err(e) = apply_autostart(settings.run_at_startup) {
        paths::log_line(&format!("autostart: {e}"));
        return SuccessResult::err(e);
    }

    // The tray is created/destroyed on the next launch rather than live —
    // keeps the tray lifecycle in one place (lib.rs setup).
    let _ = app;
    SuccessResult::ok()
}

/// Register or remove the Windows Run-key entry for this executable.
#[cfg(windows)]
fn apply_autostart(enabled: bool) -> Result<(), String> {
    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "ITaxReplyAgent";

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new("reg");
    if enabled {
        cmd.args([
            "add",
            RUN_KEY,
            "/v",
            VALUE_NAME,
            "/t",
            "REG_SZ",
            "/d",
            &format!("\"{}\"", exe.display()),
            "/f",
        ]);
    } else {
        cmd.args(["delete", RUN_KEY, "/v", VALUE_NAME, "/f"]);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    // Deleting a value that is not there is not an error for our purposes.
    if !out.status.success() && enabled {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn apply_autostart(_enabled: bool) -> Result<(), String> {
    Ok(())
}

/// Backend liveness for the UI's status indicator. Cheap: it reports the
/// cached flag plus the live port, without re-polling.
#[tauri::command]
pub fn backend_status(state: State<'_, BackendState>) -> serde_json::Value {
    json!({
        "online": state.is_online(),
        "port": state.port(),
    })
}

/// Re-run the start/poll sequence. Used by the "Check again" action on the
/// offline screen so the user is not forced to restart the app.
#[tauri::command]
pub fn retry_backend(state: State<'_, BackendState>) -> SuccessResult {
    let cfg = config::read_config();
    match backend::ensure_running(&state, &cfg) {
        Ok(_) => SuccessResult::ok(),
        Err(e) => SuccessResult::err(e),
    }
}

/// Reveal the RAG manual-ingest folder. The path comes from the backend
/// (`GET /rag/docs-folder`), but opening it is a host operation.
#[tauri::command]
pub fn open_path_in_base(app: tauri::AppHandle, path: String) -> OkResult {
    let base = paths::shell_base_dir();
    let candidate = std::path::PathBuf::from(&path);
    let resolved = candidate.canonicalize().unwrap_or(candidate);
    let base_resolved = base.canonicalize().unwrap_or_else(|_| base.clone());
    if !paths::is_within(&base_resolved, &resolved) {
        paths::log_line(&format!(
            "open_path_in_base: rejected path outside base dir: {}",
            resolved.display()
        ));
        return OkResult::err("That folder is outside the app's data directory.");
    }
    match reveal(&app, &resolved) {
        Ok(()) => OkResult::ok(),
        Err(e) => OkResult::err(e),
    }
}

/// Show the main window. Called by the renderer once it has painted, so the
/// user never sees a white flash during WebView2 startup.
#[tauri::command]
pub fn show_main_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}
