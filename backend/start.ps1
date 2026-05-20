param(
    [int]$Port = 8000
)

# Local-only launcher for the Income Tax Legal Replying Agent backend.
# Binds uvicorn to 127.0.0.1 so it is never exposed beyond this machine.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

if (-not (Test-Path ".\.venv")) {
    Write-Host "Creating virtualenv at .\.venv ..."
    python -m venv .venv
}

. .\.venv\Scripts\Activate.ps1

Write-Host "Installing requirements ..."
python -m pip install --upgrade pip | Out-Null
python -m pip install -r requirements.txt

Write-Host "Starting backend on http://127.0.0.1:$Port ..."
python -m uvicorn main:app --host 127.0.0.1 --port $Port
