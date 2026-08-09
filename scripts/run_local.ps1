# Local helper: download (+ optional 123 upload). Run from repo root or scripts/.
param(
    [string]$Channel = "stable",
    [string]$Version = "",
    [switch]$Force,
    [switch]$Upload123
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root "scripts\fetch_artifacts.py"))) {
    $Root = $PSScriptRoot
    if (-not (Test-Path (Join-Path $Root "fetch_artifacts.py"))) {
        throw "Cannot locate scripts directory"
    }
    $Scripts = $Root
    $Root = Split-Path -Parent $Scripts
} else {
    $Scripts = Join-Path $Root "scripts"
}

$Artifacts = Join-Path $Root "artifacts"
$State = Join-Path $Root "mirror\latest.json"

$argsList = @(
    (Join-Path $Scripts "fetch_artifacts.py"),
    "--channel", $Channel,
    "--out", $Artifacts,
    "--state", $State
)
if ($Force) { $argsList += "--force" }
if ($Version) { $argsList += @("--version", $Version) }

Write-Host ">> python $($argsList -join ' ')" -ForegroundColor Cyan
Push-Location $Scripts
try {
    python @argsList
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if ($Upload123) {
        $hasVip = $env:PAN123_USERNAME -and $env:PAN123_PASSWORD
        $hasOpen = $env:PAN123_CLIENT_ID -and $env:PAN123_CLIENT_SECRET
        if (-not $hasVip -and -not $hasOpen) {
            throw "Set PAN123_USERNAME+PAN123_PASSWORD (VIP) or CLIENT_ID+SECRET (Open) before -Upload123"
        }
        python (Join-Path $Scripts "upload_123pan.py") --dir $Artifacts
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
} finally {
    Pop-Location
}

Write-Host "Done. Files under: $Artifacts" -ForegroundColor Green
