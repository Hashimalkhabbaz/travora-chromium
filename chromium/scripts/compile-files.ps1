# Compile only specific object files (fast check of patched sources, keeps going after errors).
# Usage: powershell -File C:\src\compile-files.ps1 obj/a.obj obj/b.obj ...
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Objects)

$env:Path = "C:\src\depot_tools;" + $env:Path
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
$env:vs2026_install = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools'
[Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $null, 'Process')

Set-Location C:\src\chromium\src
cmd /c "autoninja -C out\Release -k 0 $($Objects -join ' ') 2>&1"
exit $LASTEXITCODE
