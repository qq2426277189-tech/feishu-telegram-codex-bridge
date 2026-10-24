# Register a per-user Startup shortcut for the hidden bridge launcher.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'FeishuTelegramCodexBridge.lnk'
$target = Join-Path $env:WINDIR 'System32\wscript.exe'
$launcher = Join-Path $root 'scripts\start-bridge-hidden.vbs'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.Arguments = '"' + $launcher + '"'
$shortcut.WorkingDirectory = $root
$shortcut.Save()
Write-Host "Installed Startup shortcut: $shortcutPath"
