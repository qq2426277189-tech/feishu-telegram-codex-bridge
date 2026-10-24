param(
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [int]$DelayMs = 0
)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ScreenNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
  try { [void][ScreenNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) }
  catch { try { [void][ScreenNative]::SetProcessDPIAware() } catch {} }
  Add-Type -AssemblyName System.Windows.Forms
  if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }
  $dir = Split-Path -Parent $OutputPath
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $x = [ScreenNative]::GetSystemMetrics(76)
  $y = [ScreenNative]::GetSystemMetrics(77)
  $width = [ScreenNative]::GetSystemMetrics(78)
  $height = [ScreenNative]::GetSystemMetrics(79)
  if ($width -le 0 -or $height -le 0) {
    $fallback = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $x = $fallback.X; $y = $fallback.Y; $width = $fallback.Width; $height = $fallback.Height
  }
  $bounds = New-Object System.Drawing.Rectangle($x, $y, $width, $height)
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  $screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    [pscustomobject]@{ device = $_.DeviceName; primary = $_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height }
  })
  $foreground = ''
  $locked = $false
  try {
    $pidValue = 0
    $hwnd = [ScreenNative]::GetForegroundWindow()
    [void][ScreenNative]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
    if ($pidValue -gt 0) {
      $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
      if ($proc) { $foreground = $proc.ProcessName }
      if ($foreground -match '^(LogonUI|LockApp)$') { $locked = $true }
    }
  } catch { }
  $visible = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 40 Id,ProcessName,MainWindowHandle,MainWindowTitle)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($OutputPath)
    try { $hash = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
    finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
  [pscustomobject]@{
    ok = $true
    path = $OutputPath
    x = $x
    y = $y
    width = $width
    height = $height
    hash = $hash
    foreground = $foreground
    locked = $locked
    screenCount = $screens.Count
    screens = $screens
    visibleWindowCount = $visible.Count
    visibleWindows = $visible
  } | ConvertTo-Json -Depth 6 -Compress
} catch {
  [pscustomobject]@{ ok = $false; path = $OutputPath; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
