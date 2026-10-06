# Live progress view for the Chromium download and build.
# Run:  powershell -ExecutionPolicy Bypass -File C:\src\progress.ps1
# Press Ctrl+C to close (it does NOT stop the download/build).
param([switch]$Once)  # -Once: print a single snapshot and exit

$logs = @(
  @{ Name = 'Download'; Path = 'C:\src\sync.log' },
  @{ Name = 'Build';    Path = 'C:\src\build.log' }
)
$startFree = $null

function Get-LastLines([string]$path, [int]$count) {
  $result = New-Object System.Collections.Generic.List[string]
  if (-not (Test-Path $path)) { return ,$result }
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
  try {
    $len = [int][Math]::Min($fs.Length, 20000)
    $fs.Seek(-$len, 'End') | Out-Null
    $buf = New-Object byte[] $len
    $fs.Read($buf, 0, $len) | Out-Null
  } finally { $fs.Close() }
  $text = [Text.Encoding]::UTF8.GetString($buf)
  foreach ($rawLine in $text.Split("`n")) {
    # git and ninja redraw progress using carriage returns; keep the latest non-empty state
    $latest = $null
    foreach ($part in $rawLine.Split("`r")) { if ($part.Trim()) { $latest = $part.Trim() } }
    if (-not $latest) { continue }
    if ($latest -match 'CategoryInfo|FullyQualifiedErrorId|^\+|^At line|^powershell :|^~+$') { continue }
    $result.Add($latest)
  }
  if ($result.Count -gt $count) { $result.RemoveRange(0, $result.Count - $count) }
  return ,$result
}

while ($true) {
  $free = (Get-PSDrive C).Free
  if ($null -eq $startFree) { $startFree = $free }
  $used = ($startFree - $free) / 1GB

  if (-not $Once) { Clear-Host }
  Write-Host "=== Chromium progress  $(Get-Date -Format 'HH:mm:ss') ===" -ForegroundColor Cyan
  Write-Host ("C: free: {0:N1} GB   (used since this window opened: {1:N1} GB)" -f ($free / 1GB), $used)
  Write-Host ""

  foreach ($log in $logs) {
    if (-not (Test-Path $log.Path)) { continue }
    $lines = Get-LastLines $log.Path 400

    # Stage markers are written by our scripts as "[HH:mm:ss] ..."; scan the whole log so early ones don't scroll away.
    $stages = Select-String -LiteralPath $log.Path -Pattern '\[\d\d:\d\d:\d\d\] .*' |
      ForEach-Object { $_.Matches[0].Value }

    Write-Host "--- $($log.Name) ---" -ForegroundColor Yellow
    foreach ($s in $stages) {
      $color = if ($s -match 'DONE') { 'Green' } else { 'Gray' }
      Write-Host "  $s" -ForegroundColor $color
    }
    # A finished log (last stage is DONE) needs no error/"Now" details - they would only show stale lines.
    if ($stages -and @($stages)[-1] -match 'DONE') { Write-Host ""; continue }
    foreach ($line in $lines) {
      if ($line -match '^FAILED:|: error|^Error|^fatal:|failed$') { Write-Host "  ! $line" -ForegroundColor Red }
    }
    Write-Host "  Now:" -ForegroundColor White
    $start = [Math]::Max(0, $lines.Count - 4)
    for ($i = $start; $i -lt $lines.Count; $i++) {
      $t = $lines[$i]
      if ($t.Length -gt 150) { $t = $t.Substring(0, 147) + '...' }
      Write-Host "    $t"
    }
    Write-Host ""
  }

  # Build progress: Siso prints nothing useful when not attached to a console, so read its
  # step log (.ninja_log: one line per finished step) and count compiled object files.
  $ninjaLog = 'C:\src\chromium\src\out\Release\.ninja_log'
  $totalFile = 'C:\src\build-total.txt'   # number of .obj compile steps for the chrome target
  if ((Test-Path $ninjaLog) -and (Test-Path $totalFile)) {
    $total = [int](Get-Content $totalFile -First 1)
    $fs = [IO.File]::Open($ninjaLog, 'Open', 'Read', 'ReadWrite')
    $reader = New-Object IO.StreamReader($fs)
    $done = 0; $steps = 0
    while ($null -ne ($l = $reader.ReadLine())) {
      if ($l.StartsWith('#')) { continue }
      $steps++
      if ($l.Contains('.obj')) { $done++ }
    }
    $reader.Close()

    if ($null -eq $script:rateStart) { $script:rateStart = @{ Time = Get-Date; Done = $done } }
    $pct = if ($total) { [Math]::Min(100, 100.0 * $done / $total) } else { 0 }
    $barWidth = 40
    $filled = [int]($barWidth * $pct / 100)
    Write-Host "--- Build progress ---" -ForegroundColor Yellow
    Write-Host ("  [{0}{1}] {2:N1}%" -f ('#' * $filled), ('.' * ($barWidth - $filled)), $pct) -ForegroundColor Green
    Write-Host ("  Compiled files: {0:N0} / {1:N0}    (all build steps finished: {2:N0})" -f $done, $total, $steps)

    $elapsed = ((Get-Date) - $script:rateStart.Time).TotalMinutes
    $gained = $done - $script:rateStart.Done
    if ($elapsed -ge 2 -and $gained -gt 0) {
      $perMin = $gained / $elapsed
      $left = [Math]::Max(0, $total - $done) / $perMin
      Write-Host ("  Speed: {0:N0} files/min   Estimated time left: {1}h {2:D2}m  (+ final linking ~15-30 min)" -f `
        $perMin, [int][Math]::Floor($left / 60), [int]($left % 60))
    } else {
      Write-Host "  Speed: measuring... (needs ~2 minutes of this window being open)" -ForegroundColor DarkGray
    }
    Write-Host ""
  }

  if ($Once) { break }
  Write-Host "(refreshes every 5s - Ctrl+C closes this window only)" -ForegroundColor DarkGray
  Start-Sleep -Seconds 5
}
