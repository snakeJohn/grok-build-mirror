# Local helper: download Grok Build artifacts. Run from repo root or scripts/.
param(
    [string]$Channel = "stable",
    [string]$Version = "",
    [switch]$Force
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
} finally {
    Pop-Location
}

Write-Host "Done. Files under: $Artifacts" -ForegroundColor Green
