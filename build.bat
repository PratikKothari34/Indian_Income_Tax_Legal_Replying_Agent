@echo off
REM ============================================================================
REM  Income Tax Legal Reply Agent — Windows .exe build script
REM
REM  Anchored to %~dp0 so it can be invoked from any working directory.
REM
REM  Pipeline:
REM    1. Tool checks (Python, Node, PyInstaller, electron-builder)
REM    2. Tesseract prerequisite check (UB Mannheim install at default path)
REM    3. backend\.venv create + pip install -r requirements.txt
REM    4. PyInstaller → dist-backend\backend.exe
REM    5. Vite + tsc → frontend\dist
REM    6. electron-builder --win --x64 → dist\ITaxReplyAgent-Setup.exe
REM    7. SHA256 + size printout
REM
REM  Run on the build machine (Pratik's laptop). The resulting installer
REM  ships to the 32GB deploy machine — do NOT run it here.
REM ============================================================================

setlocal ENABLEEXTENSIONS

echo.
echo ============================================================================
echo  ITaxReplyAgent Build Script v2.0
echo ============================================================================
echo  Project root: %~dp0
echo.

REM ----------------------------------------------------------------------------
REM  1. Tool checks
REM ----------------------------------------------------------------------------
echo [1/11] Checking Python...
python --version 1>NUL 2>NUL
if ERRORLEVEL 1 (
    echo ERROR: Python not found in PATH. Install Python 3.10+ first.
    EXIT /B 1
)

echo [2/11] Checking Node.js...
node --version 1>NUL 2>NUL
if ERRORLEVEL 1 (
    echo ERROR: Node.js not found in PATH. Install Node 24.x first.
    EXIT /B 1
)

echo [3/11] Checking PyInstaller...
python -m PyInstaller --version 1>NUL 2>NUL
if ERRORLEVEL 1 (
    echo PyInstaller missing — installing globally...
    python -m pip install pyinstaller
    if ERRORLEVEL 1 (
        echo ERROR: pip install pyinstaller failed.
        EXIT /B 1
    )
)

echo [4/11] Checking electron-builder in frontend/ ...
pushd "%~dp0frontend"
call npx electron-builder --version 1>NUL 2>NUL
if ERRORLEVEL 1 (
    echo ERROR: electron-builder not available in frontend/. Run "npm install" there first.
    popd
    EXIT /B 1
)
popd

REM ----------------------------------------------------------------------------
REM  2. Tesseract prerequisite — must exist; we DO NOT auto-install.
REM ----------------------------------------------------------------------------
echo [5/11] Checking Tesseract OCR...
if NOT EXIST "C:\Program Files\Tesseract-OCR\tesseract.exe" (
    echo.
    echo ERROR: Tesseract not found at C:\Program Files\Tesseract-OCR\
    echo.
    echo Install the UB Mannheim Tesseract build first:
    echo   https://github.com/UB-Mannheim/tesseract/wiki
    echo Then rerun this script.
    EXIT /B 1
)

REM ----------------------------------------------------------------------------
REM  3. backend\.venv — create if missing, install requirements.
REM ----------------------------------------------------------------------------
echo [6/11] Checking backend virtualenv...
if NOT EXIST "%~dp0backend\.venv\Scripts\python.exe" (
    echo Creating backend\.venv ...
    python -m venv "%~dp0backend\.venv"
    if ERRORLEVEL 1 (
        echo ERROR: venv create failed.
        EXIT /B 1
    )
    echo Installing backend\requirements.txt ...
    "%~dp0backend\.venv\Scripts\python.exe" -m pip install --upgrade pip
    "%~dp0backend\.venv\Scripts\python.exe" -m pip install -r "%~dp0backend\requirements.txt"
    if ERRORLEVEL 1 (
        echo ERROR: pip install -r requirements.txt failed.
        EXIT /B 1
    )
)

REM ----------------------------------------------------------------------------
REM  4. PyInstaller → dist-backend\backend.exe
REM ----------------------------------------------------------------------------
echo [7/11] Running PyInstaller (this can take 5-10 minutes)...
call "%~dp0backend\.venv\Scripts\activate.bat"
python -m PyInstaller "%~dp0backend.spec" ^
    --distpath "%~dp0dist-backend" ^
    --workpath "%~dp0build-backend" ^
    --noconfirm
if ERRORLEVEL 1 (
    echo ERROR: PyInstaller failed.
    EXIT /B 1
)
call "%~dp0backend\.venv\Scripts\deactivate.bat" 2>NUL

if NOT EXIST "%~dp0dist-backend\backend.exe" (
    echo ERROR: PyInstaller finished but dist-backend\backend.exe is missing.
    EXIT /B 1
)

REM ----------------------------------------------------------------------------
REM  5. Frontend build (Vite + tsc)
REM ----------------------------------------------------------------------------
echo [8/11] Building frontend (Vite + tsc)...
pushd "%~dp0frontend"
call npm run build
if ERRORLEVEL 1 (
    popd
    echo ERROR: frontend build failed.
    EXIT /B 1
)

REM ----------------------------------------------------------------------------
REM  6. electron-builder → dist\ITaxReplyAgent-Setup.exe
REM ----------------------------------------------------------------------------
echo [9/11] Running electron-builder...
call npx electron-builder --win --x64
if ERRORLEVEL 1 (
    popd
    echo ERROR: electron-builder failed.
    EXIT /B 1
)
popd

REM ----------------------------------------------------------------------------
REM  7. SHA256 + size + reminders
REM ----------------------------------------------------------------------------
set "INSTALLER=%~dp0dist\ITaxReplyAgent-Setup.exe"
if NOT EXIST "%INSTALLER%" (
    echo ERROR: expected installer at %INSTALLER% but it is missing.
    EXIT /B 1
)

echo [10/11] Computing SHA256...
echo.
echo ============================================================================
echo  Build complete!
echo ============================================================================
echo  Installer: %INSTALLER%
for %%I in ("%INSTALLER%") do echo  Size: %%~zI bytes
certutil -hashfile "%INSTALLER%" SHA256
echo.
echo [11/11] Reminders:
echo ============================================================================
echo  IMPORTANT REMINDERS:
echo  1. Run on 32GB deploy machine ONLY (14B models OOM on 8GB VRAM).
echo  2. Add Windows Defender exclusion before running the installer
echo     (PyInstaller exes routinely trigger false positives).
echo  3. Right-click installer ^> Properties ^> Unblock if SmartScreen warns.
echo  See README.md for full deployment instructions.
echo ============================================================================
echo.

endlocal
EXIT /B 0
