# Start the bridge hidden using the Node.js executable available on PATH.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Missing config.json. Copy config.example.json to config.json and edit it first."
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$configuredData = if ($config.storage.dataDir) { [string]$config.storage.dataDir } else { './data' }
$dataDir = if ([IO.Path]::IsPathRooted($configuredData)) { [IO.Path]::GetFullPath($configuredData) } else { [IO.Path]::GetFullPath((Join-Path $root $configuredData)) }
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
$pidFile = Join-Path $dataDir 'bridge.pid'
if (Test-Path -LiteralPath $pidFile) {
  $existingPid = [int](Get-Content -Raw -LiteralPath $pidFile)
  $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Bridge already running (PID $existingPid)."
    exit 0
  }
}
Start-Process -FilePath $node -ArgumentList 'bridge.js' -WorkingDirectory $root -WindowStyle Hidden
Write-Host 'Bridge started.'
