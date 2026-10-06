# Download Chromium source pinned to a release tag, without git history.
# Re-runnable: skips steps that are already done.
$ErrorActionPreference = 'Stop'
$Tag = '154.0.8037.98'
$Root = 'C:\src\chromium'

$env:Path = "C:\src\depot_tools;" + $env:Path
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
$env:vs2026_install = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

function Step($msg) { Write-Output "[$(Get-Date -Format HH:mm:ss)] $msg" }

New-Item -ItemType Directory -Force "$Root\src" | Out-Null
Set-Location "$Root\src"

# 1. Main repo: shallow fetch of just the release tag.
if (-not (Test-Path .git)) {
  git init -q
  git remote add origin https://chromium.googlesource.com/chromium/src.git
}
$head = git rev-parse -q --verify HEAD 2>$null
if (-not $head) {
  Step "Fetching chromium/src @ $Tag (shallow)..."
  git fetch --depth=1 --progress origin "refs/tags/${Tag}:refs/tags/${Tag}"
  if ($LASTEXITCODE) { throw 'git fetch failed' }
  Step 'Checking out files...'
  git checkout -q "tags/$Tag"
  if ($LASTEXITCODE) { throw 'git checkout failed' }
}
Step "src is at: $(git describe --tags)"

# 2. gclient config (src is unmanaged: gclient syncs its DEPS but leaves src on our tag).
Set-Location $Root
@"
solutions = [{
  "name": "src",
  "url": "https://chromium.googlesource.com/chromium/src.git",
  "managed": False,
  "custom_deps": {},
  "custom_vars": {},
}]
target_os = ["win"]
"@ | Set-Content -Encoding ascii .gclient

# 3. Dependencies (~200 repos) without history, then hooks (toolchains, clang, gn, etc.)
Step 'Syncing dependencies (gclient sync --no-history)...'
cmd /c "gclient sync --no-history --nohooks -D -j 8 2>&1"
if ($LASTEXITCODE) { throw 'gclient sync failed' }

Step 'Running hooks (downloads clang, gn, rust toolchain, etc.)...'
cmd /c "gclient runhooks 2>&1"
if ($LASTEXITCODE) { throw 'gclient runhooks failed' }

Step 'DONE'
