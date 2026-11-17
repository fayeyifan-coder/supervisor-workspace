$mvpRoot = 'D:\Codex-Development'
$mvpWorkspace = Join-Path $mvpRoot 'Builds\supervisor-workspace-mvp'
$mvpTemp = Join-Path $mvpRoot 'Temp\supervisor-workspace-mvp'
$mvpRuntime = Join-Path $mvpTemp 'runtime'
$mvpCache = Join-Path $mvpRoot 'Cache\supervisor-workspace-mvp'

function Assert-MvpDirectory([string]$Path, [switch]$Create) {
    if ($Create -and -not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -ErrorAction Stop | Out-Null
    }
    $entry = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $entry.PSIsContainer -or $entry.FullName -cne $Path -or
        ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Expected a regular MVP directory at $Path."
    }
}

if ($PSScriptRoot -cne $mvpWorkspace) { throw "Run the script from the independent MVP checkout." }
foreach ($path in @($mvpRoot, (Join-Path $mvpRoot 'Builds'), $mvpWorkspace,
        (Join-Path $mvpRoot 'Cache'), (Join-Path $mvpRoot 'Temp'))) {
    Assert-MvpDirectory $path
}
foreach ($path in @($mvpTemp, $mvpRuntime, $mvpCache)) {
    Assert-MvpDirectory $path -Create
}

$mvpSettings = [ordered]@{
    npm_config_cache = Join-Path $mvpCache 'npm'
    electron_config_cache = Join-Path $mvpCache 'electron'
    ELECTRON_BUILDER_CACHE = Join-Path $mvpCache 'electron-builder'
    NODE_COMPILE_CACHE = Join-Path $mvpCache 'node-compile'
    APPDATA = Join-Path $mvpRuntime 'Roaming'
    LOCALAPPDATA = Join-Path $mvpRuntime 'Local'
    TEMP = $mvpRuntime
    TMP = $mvpRuntime
    TMPDIR = $mvpRuntime
}
foreach ($path in ($mvpSettings.Values | Select-Object -Unique)) {
    Assert-MvpDirectory $path -Create
}
foreach ($directory in @('node_modules', 'build', 'dist', 'release')) {
    $path = Join-Path $mvpWorkspace $directory
    if (Test-Path -LiteralPath $path) { Assert-MvpDirectory $path }
}
Set-Location -LiteralPath $mvpWorkspace -ErrorAction Stop
foreach ($setting in $mvpSettings.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($setting.Key, $setting.Value, 'Process')
}
