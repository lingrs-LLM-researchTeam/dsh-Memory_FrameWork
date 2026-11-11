param(
    [string]$DataDir = (Join-Path $env:USERPROFILE '.memory-framework'),
    [string]$Python = 'python',
    [int]$Port = 18765
)
$ErrorActionPreference = 'Stop'
$releaseRoot = $PSScriptRoot
$runtimePath = Join-Path $DataDir 'runtime'
$runtimePython = Join-Path $runtimePath 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $runtimePython)) {
    & $Python -m venv $runtimePath
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python runtime. Python 3.12 or newer is required.' }
}
$wheel = Get-ChildItem -LiteralPath $releaseRoot -Filter 'memory_framework_dsh-*.whl' | Select-Object -First 1
if (-not $wheel) { throw 'Run this launcher from the extracted release ZIP, next to its wheel file.' }
& $runtimePython -m pip install $wheel.FullName
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
if (-not (Test-Path -LiteralPath (Join-Path $DataDir 'credentials.json'))) {
    & $runtimePython -m memory_framework init --data-dir $DataDir
    if ($LASTEXITCODE -ne 0) { throw 'Initialization failed.' }
}
Write-Host "Memory Dashboard: http://127.0.0.1:$Port"
Write-Host "The owner token is in $DataDir\credentials.json (admin_token). Keep the file private."
& $runtimePython -m memory_framework serve --data-dir $DataDir --ui-dir (Join-Path $releaseRoot 'dashboard') --port $Port
