# Restart the bridge using the configured Lark CLI and PID file.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Missing config.json.' }
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
if ($config.feishu.enabled -and $config.feishu.larkCliPath -and (Test-Path -LiteralPath $config.feishu.larkCliPath)) {
  & $config.feishu.larkCliPath event stop --force --json 2>&1 | Out-Host
}
$configuredData = if ($config.storage.dataDir) { [string]$config.storage.dataDir } else { './data' }
$dataDir = if ([IO.Path]::IsPathRooted($configuredData)) { [IO.Path]::GetFullPath($configuredData) } else { [IO.Path]::GetFullPath((Join-Path $root $configuredData)) }
$pidFile = Join-Path $dataDir 'bridge.pid'
if (Test-Path -LiteralPath $pidFile) {
  $bridgePid = [int](Get-Content -Raw -LiteralPath $pidFile)
  $process = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq 'node') {
    Stop-Process -Id $bridgePid -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped bridge PID $bridgePid."
  }
}
Start-Sleep -Seconds 2
& (Join-Path $PSScriptRoot 'start-bridge.ps1')
Start-Sleep -Seconds 3
$healthPath = Join-Path $dataDir 'health.json'
if (Test-Path -LiteralPath $healthPath) { Get-Content -Raw -LiteralPath $healthPath }
