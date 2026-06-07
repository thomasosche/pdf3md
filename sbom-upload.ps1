# Generates SBOMs for frontend (npm) and backend (Python), merges them,
# and uploads a single combined SBOM to Dependency Track.
#
# Prerequisites:
#   npm install --save-dev @cyclonedx/cyclonedx-npm
#   pip install cyclonedx-bom
#
# Configuration via .env.local:
#   DT_URL=https://dt.carrybit.de
#   DT_API_KEY=<your token>
#   DT_PROJECT_ID=ae519ed6-3517-40d0-8685-b9dd2b2480d9

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot

# Load .env.local
$EnvFile = Join-Path $ScriptDir ".env.local"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
            [System.Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), "Process")
        }
    }
}

$DT_URL        = $env:DT_URL
$DT_API_KEY    = $env:DT_API_KEY
$DT_PROJECT_ID = $env:DT_PROJECT_ID

if (-not $DT_URL)        { throw "DT_URL not set in .env.local" }
if (-not $DT_API_KEY)    { throw "DT_API_KEY not set in .env.local" }
if (-not $DT_PROJECT_ID) { throw "DT_PROJECT_ID not set in .env.local" }

$SbomFrontend = Join-Path $ScriptDir "sbom-frontend.json"
$SbomBackend  = Join-Path $ScriptDir "sbom-backend.json"
$SbomMerged   = Join-Path $ScriptDir "sbom-merged.json"
$Requirements = Join-Path $ScriptDir "pdf3md\requirements.txt"

# --- Frontend (npm) ---
Write-Host "Generating frontend SBOM..."
Push-Location $ScriptDir
npx @cyclonedx/cyclonedx-npm --output-format JSON --output-file $SbomFrontend
Pop-Location

# --- Backend (Python) ---
Write-Host "Generating backend SBOM..."
cyclonedx-py requirements $Requirements --of JSON | Out-File -Encoding utf8 $SbomBackend

# --- Merge: use frontend as base, append backend components ---
Write-Host "Merging SBOMs..."
$front = Get-Content $SbomFrontend -Raw | ConvertFrom-Json
$back  = Get-Content $SbomBackend  -Raw | ConvertFrom-Json

$mergedComponents = @($front.components) + @($back.components)
$front.components = $mergedComponents
$front | ConvertTo-Json -Depth 20 | Out-File -Encoding utf8 $SbomMerged

Write-Host "Merged: $($mergedComponents.Count) components total"

# --- Upload merged SBOM ---
Write-Host "Uploading merged SBOM..."
$bomBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($SbomMerged))
$body = @{ project = $DT_PROJECT_ID; bom = $bomBase64 } | ConvertTo-Json
Invoke-RestMethod -Uri "$DT_URL/api/v1/bom" `
    -Method Put `
    -Headers @{ "X-Api-Key" = $DT_API_KEY } `
    -ContentType "application/json" `
    -Body $body | Out-Null

Write-Host "Uploaded."
Write-Host ""
Write-Host "Done. View results at: $DT_URL/projects/$DT_PROJECT_ID"

# Clean up
Remove-Item -Force $SbomFrontend, $SbomBackend, $SbomMerged -ErrorAction SilentlyContinue
