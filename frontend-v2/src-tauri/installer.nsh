; ===========================================================================
;  Income Tax Legal Reply Agent v2 - NSIS hooks for Tauri
; ===========================================================================
;
;  Included via `bundle.windows.nsis.installerHooks` in tauri.conf.json.
;
;  This is NOT a port of `installer/installer.nsh`. That file is for
;  electron-builder and v1, and roughly 500 of its 655 lines exist to detect
;  Ollama, download it, start it as a service, and pull two ~9 GB models. v2
;  runs llama.cpp against a local .gguf the user already has, so all of it is
;  dead weight. Its custom page also collects `ollama_host`, `ollama_port`
;  and `model_storage_path` - three keys that do not exist in v2's config.
;  Copying it across would have written a config file v2 cannot read.
;
;  Tauri's hook macro names also differ from electron-builder's
;  (`customInstall` -> `NSIS_HOOK_POSTINSTALL`), so the two files are not
;  interchangeable even where the body would be.
;
;  What v2 actually needs from an installer:
;    1. Stop a running instance, so the file copy is not blocked.
;    2. Seed config-rs.json ONLY when absent, never overwriting a live one.
;    3. Offer, but never force, a user-data wipe on uninstall.
;
;  What it deliberately does NOT do:
;    - Download or install anything. No llama.cpp fetch, no model pull. A
;      multi-GB download behind a progress bar the user cannot cancel is not
;      an install step; the app's Settings panel points at a .gguf with a
;      file picker instead.
;    - Collect an Indian Kanoon token. v1 asked for it here, in a form field,
;      and wrote it to disk before the user had even seen the app. Settings
;      is the right place: it masks the field and never echoes it back.
;    - Write a backend port. v2's port must be one of 8000-8003 to satisfy
;      the app's own CSP, and the backend already walks that chain itself.
;
;  Logs to $LOCALAPPDATA\ITaxReplyAgent\logs\installer-v2.log
; ===========================================================================

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!define ITAXV2_APPDATA "$LOCALAPPDATA\ITaxReplyAgent"
!define ITAXV2_LOGS    "${ITAXV2_APPDATA}\logs"
!define ITAXV2_CFG     "${ITAXV2_APPDATA}\config-rs.json"
!define ITAXV2_LOG     "${ITAXV2_LOGS}\installer-v2.log"

Var ITaxV2_WipeData
Var ITaxV2_WipeCheckbox

!macro ITaxV2Log Msg
  Push $0
  CreateDirectory "${ITAXV2_LOGS}"
  FileOpen $0 "${ITAXV2_LOG}" a
  ${If} $0 != ""
    FileSeek $0 0 END
    FileWrite $0 "${Msg}$\r$\n"
    FileClose $0
  ${EndIf}
  Pop $0
!macroend

; ---------------------------------------------------------------------------
; Stop anything holding the install directory.
;
; Both names are tried because the backend is a separate process that
; outlives a closed window when the host dies badly. `taskkill`, not
; `pkill` - the latter does not exist on Windows.
; ---------------------------------------------------------------------------
!macro NSIS_HOOK_PREINSTALL
  !insertmacro ITaxV2Log "--- install starting ---"
  DetailPrint "Stopping any running instance..."
  nsExec::Exec 'taskkill /F /IM "backend-rs.exe" /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "Income Tax Legal Reply Agent.exe" /T'
  Pop $0
  ; Let Windows release the file handles before the copy starts.
  Sleep 1500
!macroend

; ---------------------------------------------------------------------------
; Seed a default config, but ONLY when one is not already there.
;
; This is the load-bearing rule in the file. `config-rs.json` holds the
; user's Indian Kanoon token and their chosen model paths. An installer that
; writes it unconditionally destroys both on every upgrade - and that token
; may be the only copy they have.
;
; The keys and values mirror `AppConfig::default()` in
; `src-tauri/src/config.rs`. The two must agree: this is the third copy the
; project's config-defaults rule warns about.
; ---------------------------------------------------------------------------
!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "${ITAXV2_APPDATA}"

  IfFileExists "${ITAXV2_CFG}" 0 itaxv2_write_config
    DetailPrint "Keeping your existing settings."
    !insertmacro ITaxV2Log "config-rs.json exists - left untouched."
    Goto itaxv2_config_done

  itaxv2_write_config:
    DetailPrint "Writing default configuration..."
    Push $0
    FileOpen $0 "${ITAXV2_CFG}" w
    ${If} $0 == ""
      !insertmacro ITaxV2Log "Could not open config-rs.json for write."
    ${Else}
      FileWrite $0 "{$\r$\n"
      FileWrite $0 '  "llama_host": "127.0.0.1",$\r$\n'
      FileWrite $0 '  "llama_port": 8080,$\r$\n'
      FileWrite $0 '  "llama_server_path": "",$\r$\n'
      FileWrite $0 '  "llama_model_path": "",$\r$\n'
      FileWrite $0 '  "llama_fallback_model_path": "",$\r$\n'
      FileWrite $0 '  "llama_ctx_size": 8192,$\r$\n'
      FileWrite $0 '  "llama_gpu_layers": 999,$\r$\n'
      FileWrite $0 '  "backend_port": 8000,$\r$\n'
      FileWrite $0 '  "indiankanoon_token": "",$\r$\n'
      FileWrite $0 '  "incometax_pdf_scraper_enabled": false,$\r$\n'
      FileWrite $0 '  "rag_sync_schedule": "0 12 * * *",$\r$\n'
      FileWrite $0 '  "run_at_startup": false,$\r$\n'
      FileWrite $0 '  "system_tray": true,$\r$\n'
      FileWrite $0 '  "keep_awake": true,$\r$\n'
      FileWrite $0 '  "default_temperature": 0.2,$\r$\n'
      FileWrite $0 '  "always_save_docx": true$\r$\n'
      FileWrite $0 "}$\r$\n"
      FileClose $0
      !insertmacro ITaxV2Log "config-rs.json seeded with defaults."
    ${EndIf}
    Pop $0

  itaxv2_config_done:
  !insertmacro ITaxV2Log "--- install finished ---"
!macroend

; ---------------------------------------------------------------------------
; Uninstall: data is kept unless the user opts out, twice.
;
; The default must be to keep. Sessions and generated replies are work the
; user produced; an uninstaller that deletes them to tidy a folder is
; destroying data, not cleaning up.
; ---------------------------------------------------------------------------
!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $ITaxV2_WipeData "0"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    ; A dialog that will not create must not block the uninstall. Fall
    ; through on the safe default, which is keeping the data.
    Goto itaxv2_uninstall_proceed
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 40u "The application will be removed.$\r$\n$\r$\nYour sessions, generated replies and indexed documents are kept at:$\r$\n      ${ITAXV2_APPDATA}"
  Pop $0

  ${NSD_CreateCheckbox} 0 46u 100% 12u "Also delete my data. This cannot be undone."
  Pop $ITaxV2_WipeCheckbox

  nsDialogs::Show

  ${NSD_GetState} $ITaxV2_WipeCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "Permanently delete every session, reply and indexed document in:$\r$\n      ${ITAXV2_APPDATA}$\r$\n$\r$\nThis cannot be undone." IDYES itaxv2_wipe_confirmed
    Goto itaxv2_uninstall_proceed
    itaxv2_wipe_confirmed:
    StrCpy $ITaxV2_WipeData "1"
  ${EndIf}

  itaxv2_uninstall_proceed:
  DetailPrint "Stopping any running instance..."
  nsExec::Exec 'taskkill /F /IM "backend-rs.exe" /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "Income Tax Legal Reply Agent.exe" /T'
  Pop $0
  Sleep 1500
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $ITaxV2_WipeData == "1"
    DetailPrint "Removing your data..."
    RMDir /r "${ITAXV2_APPDATA}"
    !insertmacro ITaxV2Log "User data wiped at user request."
  ${Else}
    DetailPrint "Your data has been kept at ${ITAXV2_APPDATA}"
  ${EndIf}
!macroend
