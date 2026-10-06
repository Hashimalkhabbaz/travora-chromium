# Configure and build Chromium (release, no debug symbols).
# Re-runnable: ninja/siso only rebuilds what changed, so after the first
# (long) build, rebuilding after a patch takes minutes.
param(
  [string]$OutDir = 'out\Release',
  [int]$Jobs = 10   # 16 GB RAM: keep parallel compiles bounded so the linker doesn't run out of memory
)
$ErrorActionPreference = 'Stop'

$env:Path = "C:\src\depot_tools;" + $env:Path
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
$env:vs2026_install = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

function Step($msg) { Write-Output "[$(Get-Date -Format HH:mm:ss)] $msg" }

Set-Location C:\src\chromium\src
New-Item -ItemType Directory -Force $OutDir | Out-Null

@"
# --- build type ---
is_debug = false
is_component_build = false   # one self-contained chrome.dll, like real Chrome
is_official_build = false    # official = LTO + PGO: much slower, needs far more RAM
dcheck_always_on = false
symbol_level = 0             # no debug symbols: smaller and faster to link
blink_symbol_level = 0
v8_symbol_level = 0
treat_warnings_as_errors = false

# --- behave like Google Chrome where it is fingerprintable ---
# Unofficial builds otherwise force-enable ~1100 experiments from
# testing/variations/fieldtrial_testing_config.json (e.g. ReduceAcceptLanguage,
# which cuts navigator.languages to one entry). Stable Chrome runs code defaults.
disable_fieldtrial_testing_config = true
proprietary_codecs = true    # H.264 / AAC support, as real Chrome reports
ffmpeg_branding = "Chrome"
"@ | Set-Content -Encoding ascii "$OutDir\args.gn"

Step "Generating build files in $OutDir..."
cmd /c "gn gen $OutDir 2>&1"
if ($LASTEXITCODE) { throw 'gn gen failed' }

Step "Building chrome with -j $Jobs (first build: several hours)..."
cmd /c "autoninja -C $OutDir chrome -j $Jobs 2>&1"
if ($LASTEXITCODE) { throw 'build failed' }

Step "Installing into C:\src\browser (the manager runs browsers from there)..."
& "$PSScriptRoot\install-browser.ps1" -OutDir (Resolve-Path $OutDir).Path
if (-not $?) { throw 'install failed' }

Step "DONE: $((Resolve-Path "$OutDir\chrome.exe").Path)"
