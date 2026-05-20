; ===========================================================================
;  Income Tax Legal Reply Agent — NSIS hooks for electron-builder
; ===========================================================================
;
;  Included by electron-builder via `nsis.include` in frontend/package.json.
;  Hooks the install flow with:
;
;    1. Custom configuration page (Ollama host/ports, model storage, IK token)
;    2. Field validation + disk-space pre-check (gates the Next button)
;    3. Ollama detection + auto-install (NSISdl download with 3-retry)
;    4. Ollama serve start (with already-running detection)
;    5. Model pull for qwen2.5:14b then deepseek-r1:14b (with retry + skip)
;    6. config.json + port.txt initial write to %LOCALAPPDATA%\ITaxReplyAgent
;
;  Clean uninstaller (`customUnInstall` macro at end of file):
;    - Kills backend.exe + the Electron .exe before deleting Program Files
;    - Optional checkbox to also wipe %LOCALAPPDATA%\ITaxReplyAgent
;    - Confirmation dialogs before each destructive step
;
;  Required NSIS plugins (must be present in NSIS\Plugins\x86-unicode):
;    - NSISdl      ships with NSIS — no extra install
;    - nsExec.dll  ships with NSIS — no extra install
;    - nsDialogs   ships with NSIS — no extra install
;
;  Logs to $LOCALAPPDATA\ITaxReplyAgent\logs\installer.log
; ===========================================================================

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"
!include "WinVer.nsh"

!define ITAX_APPDATA  "$LOCALAPPDATA\ITaxReplyAgent"
!define ITAX_LOGS     "${ITAX_APPDATA}\logs"
!define ITAX_CFG      "${ITAX_APPDATA}\config.json"
!define ITAX_PORT     "${ITAX_APPDATA}\port.txt"
!define ITAX_INST_LOG "${ITAX_LOGS}\installer.log"
!define OLLAMA_URL    "https://ollama.com/download/OllamaSetup.exe"
!define OLLAMA_MIN_SIZE 52428800   ; 50 MB

; ---------------------------------------------------------------------------
; Variables shared across pages
; ---------------------------------------------------------------------------
Var Cfg_OllamaHost
Var Cfg_OllamaPort
Var Cfg_BackendPort
Var Cfg_ModelPath
Var Cfg_IkToken

Var Hwnd_OllamaHost
Var Hwnd_OllamaPort
Var Hwnd_BackendPort
Var Hwnd_ModelPath
Var Hwnd_BrowseBtn
Var Hwnd_IkToken
Var Hwnd_ValidationLabel

; Uninstaller-only variables
Var Hwnd_WipeDataCheckbox
Var WipeUserData

; ---------------------------------------------------------------------------
; Logging macros
; ---------------------------------------------------------------------------
!macro ITaxLog Msg
  Push $0
  CreateDirectory "${ITAX_LOGS}"
  FileOpen $0 "${ITAX_INST_LOG}" a
  FileSeek $0 0 END
  FileWrite $0 "${Msg}$\r$\n"
  FileClose $0
  Pop $0
!macroend

!macro ITaxFatal Msg
  !insertmacro ITaxLog "FATAL: ${Msg}"
  MessageBox MB_ICONSTOP "${Msg}"
  Abort
!macroend

; ===========================================================================
; customHeader — declare the custom configuration page so it runs before
; the standard install-files page.
; ===========================================================================
!macro customHeader
  Page custom ITaxConfigPageShow ITaxConfigPageLeave
!macroend

; ===========================================================================
; preInit — seed defaults at the very start of .onInit.
; ===========================================================================
!macro preInit
  StrCpy $Cfg_OllamaHost  "127.0.0.1"
  StrCpy $Cfg_OllamaPort  "11434"
  StrCpy $Cfg_BackendPort "8000"
  StrCpy $Cfg_ModelPath   "$PROFILE\.ollama\models"
  StrCpy $Cfg_IkToken     ""
  CreateDirectory "${ITAX_APPDATA}"
  CreateDirectory "${ITAX_LOGS}"
  !insertmacro ITaxLog "Installer started for build $%COMPUTERNAME%"
!macroend

; ===========================================================================
; Custom configuration page — nsDialogs.
; ===========================================================================
Function ITaxConfigPageShow
  !insertmacro MUI_HEADER_TEXT "Configuration" "Set network and storage options."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 12u "Ollama Host:"
  Pop $0
  ${NSD_CreateText} 0 12u 100% 12u "$Cfg_OllamaHost"
  Pop $Hwnd_OllamaHost

  ${NSD_CreateLabel} 0 28u 100% 12u "Ollama Port (1024-65535):"
  Pop $0
  ${NSD_CreateNumber} 0 40u 100% 12u "$Cfg_OllamaPort"
  Pop $Hwnd_OllamaPort

  ${NSD_CreateLabel} 0 56u 100% 12u "Backend Port (1024-65535):"
  Pop $0
  ${NSD_CreateNumber} 0 68u 100% 12u "$Cfg_BackendPort"
  Pop $Hwnd_BackendPort

  ${NSD_CreateLabel} 0 84u 100% 12u "Model Storage Path (>= 25 GB free):"
  Pop $0
  ${NSD_CreateText} 0 96u 80% 12u "$Cfg_ModelPath"
  Pop $Hwnd_ModelPath
  ${NSD_CreateButton} 82% 96u 18% 12u "Browse..."
  Pop $Hwnd_BrowseBtn
  ${NSD_OnClick} $Hwnd_BrowseBtn ITaxBrowseModelPath

  ${NSD_CreateLabel} 0 112u 100% 18u "Indian Kanoon API Token (optional, leave blank to disable auto-fetch):"
  Pop $0
  ${NSD_CreatePassword} 0 130u 100% 12u "$Cfg_IkToken"
  Pop $Hwnd_IkToken

  ${NSD_CreateLabel} 0 148u 100% 24u ""
  Pop $Hwnd_ValidationLabel
  SetCtlColors $Hwnd_ValidationLabel 0xC00000 transparent

  nsDialogs::Show
FunctionEnd

Function ITaxBrowseModelPath
  ${NSD_GetText} $Hwnd_ModelPath $0
  nsDialogs::SelectFolderDialog "Select model storage folder" "$0"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $Hwnd_ModelPath "$0"
  ${EndIf}
FunctionEnd

Function ITaxConfigPageLeave
  ${NSD_GetText} $Hwnd_OllamaHost  $Cfg_OllamaHost
  ${NSD_GetText} $Hwnd_OllamaPort  $Cfg_OllamaPort
  ${NSD_GetText} $Hwnd_BackendPort $Cfg_BackendPort
  ${NSD_GetText} $Hwnd_ModelPath   $Cfg_ModelPath
  ${NSD_GetText} $Hwnd_IkToken     $Cfg_IkToken

  ; ---- Port validation -------------------------------------------------
  ${If} $Cfg_OllamaPort < 1024
  ${OrIf} $Cfg_OllamaPort > 65535
    ${NSD_SetText} $Hwnd_ValidationLabel "Ollama port must be between 1024 and 65535."
    Abort
  ${EndIf}
  ${If} $Cfg_BackendPort < 1024
  ${OrIf} $Cfg_BackendPort > 65535
    ${NSD_SetText} $Hwnd_ValidationLabel "Backend port must be between 1024 and 65535."
    Abort
  ${EndIf}
  ${If} $Cfg_BackendPort == $Cfg_OllamaPort
    ${NSD_SetText} $Hwnd_ValidationLabel "Backend port and Ollama port must differ."
    Abort
  ${EndIf}

  ; ---- Model path validation + create if missing -----------------------
  StrCmp $Cfg_ModelPath "" 0 +3
    ${NSD_SetText} $Hwnd_ValidationLabel "Model storage path is required."
    Abort
  CreateDirectory "$Cfg_ModelPath"
  IfFileExists "$Cfg_ModelPath\*.*" +3 0
    ${NSD_SetText} $Hwnd_ValidationLabel "Model storage path is not writable."
    Abort

  ; ---- Disk-space gating ------------------------------------------------
  ; C: install drive must have >= 500 MB free.
  ${DriveSpace} "$INSTDIR" "/D=F /S=M" $0
  ${If} $0 < 500
    ${NSD_SetText} $Hwnd_ValidationLabel "Install drive needs at least 500 MB free; you have $0 MB."
    Abort
  ${EndIf}
  ; Model storage drive must have >= 25 GB free.
  Push "$Cfg_ModelPath"
  Call ITaxGetDriveLetter
  Pop $1
  ${DriveSpace} "$1" "/D=F /S=G" $0
  ${If} $0 < 25
    ${NSD_SetText} $Hwnd_ValidationLabel "Model drive needs at least 25 GB free (have $0 GB). Pick another path."
    Abort
  ${EndIf}

  !insertmacro ITaxLog "Config: ollama=$Cfg_OllamaHost:$Cfg_OllamaPort backend=$Cfg_BackendPort models=$Cfg_ModelPath ik_token_set=yesNoUnused"
FunctionEnd

; Helper: extract a 2-char drive prefix ("C:") from any absolute path.
Function ITaxGetDriveLetter
  Exch $0
  Push $1
  StrCpy $1 $0 2
  StrCpy $0 $1
  Pop $1
  Exch $0
FunctionEnd

Function ITaxFirstLine
  Exch $0
  Push $1
  Push $2
  StrCpy $1 0
  loop:
    StrCpy $2 $0 1 $1
    ${If} $2 == "$\r"
    ${OrIf} $2 == "$\n"
      StrCpy $0 $0 $1
      Goto done
    ${EndIf}
    IntOp $1 $1 + 1
    StrLen $2 $0
    ${If} $1 >= $2
      Goto done
    ${EndIf}
    Goto loop
  done:
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

; ===========================================================================
; Ollama detection — sets $0 = "yes"/"no", $1 = resolved exe path (may be "").
; ===========================================================================
Function ITaxDetectOllama
  ; 1. PATH lookup
  nsExec::ExecToStack 'where ollama'
  Pop $2
  Pop $3
  ${If} $2 == 0
    Push $3
    Call ITaxFirstLine
    Pop $1
    StrCpy $0 "yes"
    Return
  ${EndIf}

  ; 2. %LOCALAPPDATA%\Programs\Ollama\ollama.exe
  StrCpy $1 "$LOCALAPPDATA\Programs\Ollama\ollama.exe"
  IfFileExists "$1" 0 +3
    StrCpy $0 "yes"
    Return

  ; 3. C:\Program Files\Ollama\ollama.exe
  StrCpy $1 "$PROGRAMFILES64\Ollama\ollama.exe"
  IfFileExists "$1" 0 +3
    StrCpy $0 "yes"
    Return

  ; 4. Windows service "Ollama"
  nsExec::ExecToStack 'sc query Ollama'
  Pop $2
  Pop $3
  ${If} $2 == 0
    StrCpy $0 "yes"
    StrCpy $1 ""
    Return
  ${EndIf}

  StrCpy $0 "no"
  StrCpy $1 ""
FunctionEnd

; ===========================================================================
; Ollama download + install — 3-retry, skip on user opt-out.
; ===========================================================================
Function ITaxInstallOllama
  StrCpy $0 "$TEMP\OllamaSetup.exe"
  StrCpy $1 0  ; attempt counter

  retry:
  IntOp $1 $1 + 1
  !insertmacro ITaxLog "Downloading Ollama (attempt $1)"
  NSISdl::download "${OLLAMA_URL}" "$0"
  Pop $2
  ${If} $2 != "success"
    !insertmacro ITaxLog "Ollama download failed: $2"
    ${If} $1 < 3
      Goto retry
    ${EndIf}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION \
      "Could not download Ollama after 3 attempts.$\n$\nDownload it manually from https://ollama.com and rerun this installer.$\n$\nSkip Ollama install and continue?" IDYES skip
    !insertmacro ITaxFatal "User aborted installation."
    skip:
    !insertmacro ITaxLog "User skipped Ollama download."
    Return
  ${EndIf}

  ; Sanity-check: real installer is at least 50 MB.
  ${GetSize} "$0" "/" $3 $4 $5
  ${If} $3 < ${OLLAMA_MIN_SIZE}
    !insertmacro ITaxLog "OllamaSetup.exe size $3 < ${OLLAMA_MIN_SIZE} -- likely error page"
    Delete "$0"
    ${If} $1 < 3
      Goto retry
    ${EndIf}
    !insertmacro ITaxFatal "Downloaded OllamaSetup.exe looks corrupt; aborting."
  ${EndIf}

  !insertmacro ITaxLog "Running OllamaSetup.exe /S"
  nsExec::ExecToLog '"$0" /S'
  Pop $2
  ${If} $2 != 0
    !insertmacro ITaxLog "OllamaSetup.exe exit code $2"
  ${EndIf}

  ; Poll for ollama.exe up to 120 s.
  StrCpy $1 0
  poll:
  IntOp $1 $1 + 1
  Sleep 2000
  Call ITaxDetectOllama
  ${If} $0 == "yes"
    !insertmacro ITaxLog "Ollama installed and detected."
    Return
  ${EndIf}
  ${If} $1 < 60
    Goto poll
  ${EndIf}
  !insertmacro ITaxFatal "Ollama install completed but ollama.exe was not detected within 120 s."
FunctionEnd

; ===========================================================================
; Start Ollama service / detached serve.
; ===========================================================================
Function ITaxStartOllama
  ; Already-running service?
  nsExec::ExecToStack 'sc query Ollama'
  Pop $2
  Pop $3
  ${If} $2 == 0
    StrCpy $4 ""
    StrLen $R8 "RUNNING"
    StrCpy $R9 0
    loop_ollama1:
      StrCpy $R7 $3 $R8 $R9
      StrCmp $R7 "" done_ollama1
      StrCmp $R7 "RUNNING" found_ollama1
      IntOp $R9 $R9 + 1
      Goto loop_ollama1
    found_ollama1:
      StrCpy $4 "RUNNING"
    done_ollama1:
    ${If} $4 != ""
      !insertmacro ITaxLog "Ollama Windows service already running."
      Return
    ${EndIf}
  ${EndIf}

  ; Port already bound? (User may be running ollama serve themselves.)
  nsExec::ExecToStack 'powershell -NoProfile -Command "try{(New-Object System.Net.Sockets.TcpClient).ConnectAsync(\"$Cfg_OllamaHost\", $Cfg_OllamaPort).Wait(1000);exit 0}catch{exit 1}"'
  Pop $2
  Pop $3
  ${If} $2 == 0
    !insertmacro ITaxLog "Ollama already listening on $Cfg_OllamaHost:$Cfg_OllamaPort -- skip start."
    Return
  ${EndIf}

  ; Non-default model path? Export OLLAMA_MODELS for this user.
  ${If} $Cfg_ModelPath != "$PROFILE\.ollama\models"
    nsExec::ExecToLog 'setx OLLAMA_MODELS "$Cfg_ModelPath"'
    Pop $2
    !insertmacro ITaxLog "OLLAMA_MODELS = $Cfg_ModelPath"
  ${EndIf}

  ; Detached `ollama serve` so the installer doesn't block.
  Call ITaxDetectOllama
  ${If} $0 != "yes"
    !insertmacro ITaxFatal "Ollama not found when trying to start serve."
  ${EndIf}
  ${If} $1 != ""
    nsExec::Exec '"$1" serve'
  ${Else}
    nsExec::Exec 'ollama serve'
  ${EndIf}

  ; Poll http://host:port for up to 30 s.
  StrCpy $5 0
  serve_poll:
  IntOp $5 $5 + 1
  Sleep 2000
  nsExec::ExecToStack 'powershell -NoProfile -Command "try{(Invoke-WebRequest -Uri http://$Cfg_OllamaHost`:$Cfg_OllamaPort/ -UseBasicParsing -TimeoutSec 2).StatusCode}catch{exit 1}"'
  Pop $2
  Pop $3
  ${If} $2 == 0
    !insertmacro ITaxLog "Ollama responding on http://$Cfg_OllamaHost:$Cfg_OllamaPort"
    Return
  ${EndIf}
  ${If} $5 < 15
    Goto serve_poll
  ${EndIf}
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Ollama did not start within 30 seconds. Retry?" IDRETRY ITaxStartOllamaRetry
  !insertmacro ITaxLog "User cancelled Ollama start."
  Return
  ITaxStartOllamaRetry:
  Call ITaxStartOllama
FunctionEnd

; ===========================================================================
; Pull one model (with 3-retry, skip on persistent failure).
; Stack: model name (e.g. "qwen2.5:14b")
; ===========================================================================
Function ITaxPullModel
  Exch $9
  Push $0
  Push $1
  StrCpy $1 0

  ; Already pulled?
  nsExec::ExecToStack 'cmd /c ollama list'
  Pop $0
  Pop $2
  StrCpy $3 ""
  StrLen $R8 $9
  StrCpy $R9 0
  loop_model1:
    StrCpy $R7 $2 $R8 $R9
    StrCmp $R7 "" done_model1
    StrCmp $R7 $9 found_model1
    IntOp $R9 $R9 + 1
    Goto loop_model1
  found_model1:
    StrCpy $3 $9
  done_model1:
  ${If} $3 != ""
    DetailPrint "OK Already installed: $9"
    !insertmacro ITaxLog "Model $9 already installed; skipping."
    Goto pull_done
  ${EndIf}

  pull_retry:
  IntOp $1 $1 + 1
  DetailPrint "Pulling $9 (attempt $1) — may take 5-15 minutes ..."
  !insertmacro ITaxLog "Pulling $9 (attempt $1)"
  nsExec::ExecToLog 'cmd /c ollama pull $9'
  Pop $0
  ${If} $0 == 0
    DetailPrint "OK $9 pulled."
    !insertmacro ITaxLog "Model $9 pulled."
    Goto pull_done
  ${EndIf}
  !insertmacro ITaxLog "ollama pull $9 failed (exit $0)"
  ${If} $1 < 3
    DetailPrint "Pull failed, retrying ($1/3) ..."
    Goto pull_retry
  ${EndIf}

  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
    "Could not pull model $9 after 3 attempts.$\n$\nYou can run 'ollama pull $9' manually later.$\n$\nClick OK to continue installation, Cancel to abort." IDOK skip_model
  !insertmacro ITaxFatal "User aborted because $9 could not be pulled."
  skip_model:
  DetailPrint "WARNING: skipped $9 -- install will continue."

  pull_done:
  Pop $1
  Pop $0
  Pop $9
FunctionEnd

; ===========================================================================
; Write %LOCALAPPDATA%\ITaxReplyAgent\config.json
; ===========================================================================
Function ITaxWriteConfig
  Push $0
  CreateDirectory "${ITAX_APPDATA}"
  ; Escape backslashes for JSON.
  ${WordReplace} "$Cfg_ModelPath" "\" "\\" "+" $1
  ; Token: escape both backslash and double-quote, in that order.
  ${WordReplace} "$Cfg_IkToken" "\" "\\" "+" $2
  ${WordReplace} "$2"           '"'  '\"' "+" $2
  FileOpen $0 "${ITAX_CFG}" w
  ${If} $0 == ""
    !insertmacro ITaxLog "Could not open config.json for write."
  ${Else}
    FileWrite $0 "{$\r$\n"
    FileWrite $0 '  "ollama_host": "$Cfg_OllamaHost",$\r$\n'
    FileWrite $0 '  "ollama_port": $Cfg_OllamaPort,$\r$\n'
    FileWrite $0 '  "backend_port": $Cfg_BackendPort,$\r$\n'
    FileWrite $0 '  "model_storage_path": "$1",$\r$\n'
    FileWrite $0 '  "indiankanoon_token": "$2",$\r$\n'
    FileWrite $0 '  "incometax_pdf_scraper_enabled": false,$\r$\n'
    FileWrite $0 '  "rag_sync_schedule": "0 12 * * *",$\r$\n'
    FileWrite $0 '  "run_at_startup": false,$\r$\n'
    FileWrite $0 '  "system_tray": true,$\r$\n'
    FileWrite $0 '  "keep_awake": true$\r$\n'
    FileWrite $0 "}$\r$\n"
    FileClose $0
    !insertmacro ITaxLog "config.json written. (IK token not echoed for security.)"
  ${EndIf}
  ; Seed port.txt; backend rewrites this on fallback.
  FileOpen $0 "${ITAX_PORT}" w
  ${If} $0 != ""
    FileWrite $0 "$Cfg_BackendPort"
    FileClose $0
  ${EndIf}
  Pop $0
FunctionEnd

; ===========================================================================
; customInstall — runs after files are copied. Heavy lifting goes here.
; ===========================================================================
!macro customInstall
  DetailPrint "Detecting Ollama..."
  Call ITaxDetectOllama
  ${If} $0 == "no"
    DetailPrint "Ollama not found. Downloading..."
    Call ITaxInstallOllama
  ${Else}
    !insertmacro ITaxLog "Ollama detected at $1"
  ${EndIf}

  DetailPrint "Starting Ollama..."
  Call ITaxStartOllama

  DetailPrint "Pulling qwen2.5:14b ..."
  Push "qwen2.5:14b"
  Call ITaxPullModel

  DetailPrint "Pulling deepseek-r1:14b ..."
  Push "deepseek-r1:14b"
  Call ITaxPullModel

  DetailPrint "Writing configuration..."
  Call ITaxWriteConfig

  DetailPrint "Installation complete."
!macroend

; ===========================================================================
; ===========================================================================
;                              UNINSTALLER
; ===========================================================================
; ===========================================================================
;
; Default: preserves %LOCALAPPDATA%\ITaxReplyAgent (sessions, output docs,
; RAG index, config). User-opt-in checkbox wipes that too with a second
; confirmation dialog.
;
; Always kills running backend.exe + the Electron app before deleting
; Program Files — otherwise file-in-use locks block the directory removal.

; ---------------------------------------------------------------------------
; customUnInit — runs at the start of the uninstaller. Show our intro/wipe
; dialog using nsDialogs so we can offer the data-wipe checkbox.
; ---------------------------------------------------------------------------
!macro customUnInit
  StrCpy $WipeUserData "0"
!macroend

; ---------------------------------------------------------------------------
; Custom page on the uninstaller that asks the data-preservation question.
; electron-builder's NSIS template offers `customUnPage` hook by including
; a Page custom directive in customUnHeader.
; ---------------------------------------------------------------------------
!macro customUnHeader
  UninstPage custom un.ITaxConfirmPageShow un.ITaxConfirmPageLeave
!macroend

Function un.ITaxConfirmPageShow
  !insertmacro MUI_HEADER_TEXT "Uninstall Income Tax Legal Reply Agent" \
    "Choose whether to keep your data."

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 36u \
    "This will remove the application from:$\r$\n      $INSTDIR$\r$\n$\r$\nYour data (sessions, generated replies, indexed documents) will be PRESERVED at:$\r$\n      ${ITAX_APPDATA}$\r$\nunless you check the box below."
  Pop $0

  ${NSD_CreateCheckbox} 0 50u 100% 12u "Also delete all my data (sessions, replies, RAG documents). This cannot be undone."
  Pop $Hwnd_WipeDataCheckbox

  ${NSD_CreateLabel} 0 68u 100% 24u \
    "Note: Ollama itself, any pulled models (qwen2.5:14b, deepseek-r1:14b), and Tesseract OCR are NOT removed by this uninstaller — those were installed separately."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function un.ITaxConfirmPageLeave
  ${NSD_GetState} $Hwnd_WipeDataCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $WipeUserData "1"
    MessageBox MB_YESNO|MB_ICONEXCLAMATION \
      "WARNING: This will permanently delete all your sessions, generated replies, and indexed RAG documents in:$\r$\n      ${ITAX_APPDATA}$\r$\n$\r$\nThis cannot be undone. Continue?" IDYES wipe_confirmed
    ; User said No to the wipe; clear the flag but stay on the page.
    StrCpy $WipeUserData "0"
    ${NSD_SetState} $Hwnd_WipeDataCheckbox ${BST_UNCHECKED}
    Abort
    wipe_confirmed:
  ${Else}
    StrCpy $WipeUserData "0"
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; customUnInstall — actual removal. electron-builder calls this AFTER its
; standard uninstall steps but BEFORE the registry/shortcut cleanup.
; ---------------------------------------------------------------------------
!macro customUnInstall
  ; ---- Stop running processes so the file delete won't be blocked -----
  DetailPrint "Stopping any running processes..."
  nsExec::Exec 'taskkill /F /IM backend.exe /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "Income Tax Legal Reply Agent.exe" /T'
  Pop $0
  Sleep 2000

  ; ---- Optional user-data wipe ---------------------------------------
  ${If} $WipeUserData == "1"
    DetailPrint "Removing user data at ${ITAX_APPDATA} ..."
    RMDir /r "${ITAX_APPDATA}"
    ${If} ${Errors}
      DetailPrint "WARNING: some files in ${ITAX_APPDATA} could not be deleted (may be open in another process)."
    ${EndIf}
  ${Else}
    DetailPrint "Preserving user data at ${ITAX_APPDATA}"
  ${EndIf}

  ; ---- Final user-facing summary -------------------------------------
  ${If} $WipeUserData == "1"
    MessageBox MB_ICONINFORMATION \
      "Income Tax Legal Reply Agent has been uninstalled.$\r$\n$\r$\nYour data at ${ITAX_APPDATA} has been removed as requested."
  ${Else}
    MessageBox MB_ICONINFORMATION \
      "Income Tax Legal Reply Agent has been uninstalled.$\r$\n$\r$\nYour data remains at:$\r$\n      ${ITAX_APPDATA}$\r$\n$\r$\nDelete that folder manually if you no longer need it."
  ${EndIf}
!macroend
