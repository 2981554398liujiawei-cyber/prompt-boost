$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$defaultDataDir = Join-Path $projectRoot "apps\local-agent\data"
$dataDir = if ($env:LOCAL_AGENT_DATA_DIR) { $env:LOCAL_AGENT_DATA_DIR } else { $defaultDataDir }
$pidFile = if ($env:LOCAL_AGENT_PID_FILE) { $env:LOCAL_AGENT_PID_FILE } else { Join-Path $dataDir "local-agent.pid" }

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Output "Prompt Boost local agent is not running (PID file not found)."
  exit 0
}

$rawRecord = (Get-Content -LiteralPath $pidFile -Raw).Trim()
try {
  if ($rawRecord.StartsWith("{")) {
    $record = $rawRecord | ConvertFrom-Json
  } else {
    $record = [pscustomobject]@{ pid = [int]$rawRecord; port = 8787; authTokenFile = (Join-Path $dataDir ".auth-token") }
  }
} catch {
  throw "Invalid Prompt Boost PID file; refusing to stop any process."
}
$targetPid = [int]$record.pid
$targetPort = if ($record.port) { [int]$record.port } else { 8787 }
$authTokenFile = if ($record.authTokenFile) { [string]$record.authTokenFile } else { Join-Path $dataDir ".auth-token" }
if ($targetPid -le 0) { throw "Invalid Prompt Boost PID file; refusing to stop any process." }

$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid"
if ($null -eq $processInfo) {
  Remove-Item -LiteralPath $pidFile -Force
  Write-Output "Prompt Boost local agent is already stopped; stale PID file removed."
  exit 0
}

$normalizedCommand = ($processInfo.CommandLine -replace '/', '\').ToLowerInvariant()
$listener = Get-NetTCPConnection -State Listen -LocalPort $targetPort -ErrorAction SilentlyContinue |
  Where-Object { $_.OwningProcess -eq $targetPid }
if ($processInfo.Name -notmatch '^node(\.exe)?$' -or $normalizedCommand -notmatch 'dist\\server\.js' -or $null -eq $listener) {
  throw "PID $targetPid does not belong to Prompt Boost; refusing to stop it."
}

Write-Output "Stopping Prompt Boost local agent (PID $targetPid)..."
if (-not (Test-Path -LiteralPath $authTokenFile)) {
  throw "Prompt Boost auth token file is missing; refusing unauthenticated shutdown."
}
$token = (Get-Content -LiteralPath $authTokenFile -Raw).Trim()
try {
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$targetPort/v1/system/shutdown" `
    -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5 | Out-Null
} catch {
  Write-Warning "Authenticated graceful shutdown request failed; waiting before verified force-stop."
}
$exited = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  if ($null -eq (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
    $exited = $true
    break
  }
}
if (-not $exited) {
  Write-Warning "Graceful shutdown timed out; forcing the verified Prompt Boost process to stop."
  Stop-Process -Id $targetPid -Force
}
if (Test-Path -LiteralPath $pidFile) {
  Remove-Item -LiteralPath $pidFile -Force
}
Write-Output "Prompt Boost local agent stopped."
