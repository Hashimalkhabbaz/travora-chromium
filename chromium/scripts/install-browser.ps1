# Copy the runtime files of the latest build into its own folder, so the
# manager runs browsers from there and rebuilding never touches files that open
# profiles are using (chrome.dll is locked while a browser runs).
#
#   C:\src\browser\<version>-<timestamp>\chrome.exe   one folder per install
#   C:\src\browser\latest.txt                         path of the newest chrome.exe
#
# The file list is Chromium's own snapshot archive list
# (infra/archive_config/win-archive-rel.json, chrome-win.zip), minus test binaries.
param(
  [string]$OutDir = 'C:\src\chromium\src\out\Release',
  [string]$InstallRoot = 'C:\src\browser',
  [int]$Keep = 3
)
$ErrorActionPreference = 'Stop'

$files = @(
  'chrome.exe', 'chrome.dll', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
  'chrome_elf.dll', 'chrome_proxy.exe', 'chrome_pwa_launcher.exe', 'chrome_wer.dll',
  'D3DCompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'elevated_tracing_service.exe',
  'elevation_service.exe', 'eventlog_provider.dll', 'First Run', 'icudtl.dat',
  'IwaKeyDistribution\iwa-key-distribution.pb', 'IwaKeyDistribution\manifest.json',
  'libEGL.dll', 'libGLESv2.dll', 'MEIPreload\manifest.json', 'MEIPreload\preloaded_data.pb',
  'notification_helper.exe', 'PrivacySandboxAttestationsPreloaded\manifest.json',
  'PrivacySandboxAttestationsPreloaded\privacy-sandbox-attestations.dat',
  'resources.pak', 'v8_context_snapshot.bin', 'vk_swiftshader.dll',
  'vk_swiftshader_icd.json', 'vulkan-1.dll'
)
$globs = @('locales\*.pak', '*.manifest')

$version = (Get-Item (Join-Path $OutDir 'chrome.exe')).VersionInfo.ProductVersion
$target = Join-Path $InstallRoot ("{0}-{1}" -f $version, (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $target | Out-Null

foreach ($f in $files) {
  $dest = Join-Path $target $f
  New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
  Copy-Item -LiteralPath (Join-Path $OutDir $f) -Destination $dest
}
foreach ($g in $globs) {
  $destDir = Join-Path $target (Split-Path $g)
  New-Item -ItemType Directory -Force $destDir | Out-Null
  Copy-Item -Path (Join-Path $OutDir $g) -Destination $destDir
}

$exe = Join-Path $target 'chrome.exe'
Set-Content -Path (Join-Path $InstallRoot 'latest.txt') -Value $exe -Encoding ascii
Write-Output "Installed $version -> $exe"

# Remove older installs, keeping the newest $Keep. Skip any install a running
# browser uses: deleting it would remove files that browser still loads later.
$running = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.ExecutablePath } | ForEach-Object { Split-Path $_.ExecutablePath })
Get-ChildItem $InstallRoot -Directory |
  Sort-Object CreationTime -Descending |
  Select-Object -Skip $Keep |
  ForEach-Object {
    if ($running -contains $_.FullName) {
      Write-Output "Kept $($_.Name) (in use by an open profile)"
    } else {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
      Write-Output "Removed old install $($_.Name)"
    }
  }
