[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'PrepareLegacy', 'ActivatePrimary', 'ReviewOperations', 'CreateShortcut')]
    [string] $Operation,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('\A[0-9a-f]{40}\z')]
    [string] $Commit,
    [string] $AcceptanceRoot,
    [string] $PackageRoot,
    [string] $InputPath,
    [string] $ExpectedSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Require-Directory([string] $Path, [bool] $Create = $false) {
    $drive = [IO.Path]::GetPathRoot($Path)
    if ($drive -cnotmatch '\A[A-Z]:\\\z' -or $Path -cne [IO.Path]::GetFullPath($Path)) {
        throw "Expected an absolute local directory: $Path"
    }
    $driveInfo = [IO.DriveInfo]::new($drive)
    if ($driveInfo.DriveType -ne [IO.DriveType]::Fixed -or $driveInfo.DriveFormat -cne 'NTFS') {
        throw "Expected a fixed NTFS volume: $drive"
    }
    $current = $drive
    foreach ($segment in $Path.Substring($drive.Length).Split('\', [StringSplitOptions]::RemoveEmptyEntries)) {
        $current = Join-Path $current $segment
        if ($Create -and !(Test-Path -LiteralPath $current)) {
            New-Item -ItemType Directory -Path $current | Out-Null
        }
        $entry = Get-Item -LiteralPath $current -Force
        if (!$entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.FullName -cne $current) {
            throw "Unexpected directory or reparse point: $current"
        }
    }
}

function Require-File([string] $Path) {
    $entry = Get-Item -LiteralPath $Path -Force
    if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.FullName -cne $Path) {
        throw "Unexpected file or reparse point: $Path"
    }
    return $entry
}

function Manifest-Files([string] $Package) {
    Require-Directory $Package
    $stamp = Join-Path $Package 'build-info.json'
    $sums = Join-Path $Package 'SHA256SUMS.txt'
    foreach ($required in @($stamp, $sums)) {
        if ((Require-File $required).Length -gt 65536) { throw "Invalid manifest size: $required" }
    }
    $hashes = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in [IO.File]::ReadAllLines($sums)) {
        if ($line -cnotmatch '\A([0-9a-f]{64}) \*(build-info\.json|win-unpacked/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)?|deploy/Production-Admission\.ps1)\z') {
            throw 'Unexpected entry in the candidate SHA-256 list.'
        }
        $digest = $Matches[1]
        $name = $Matches[2]
        if (@($name.Split('/') | Where-Object { $_ -in @('.', '..') }).Count -gt 0) {
            throw 'Invalid manifest path component.'
        }
        $hashes.Add($name, $digest)
        $file = Join-Path $Package $name.Replace('/', '\')
        Require-Directory ([IO.Path]::GetDirectoryName($file))
        $null = Require-File $file
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash -ine $digest) {
            throw "SHA-256 mismatch: $name"
        }
    }
    foreach ($name in @('build-info.json', 'win-unpacked/SupervisorWorkspace-MVP.exe',
        'win-unpacked/resources/app.asar', 'win-unpacked/resources/recovery-io.exe')) {
        if (!$hashes.ContainsKey($name)) { throw "Missing manifest entry: $name" }
    }
    $metadata = [IO.File]::ReadAllText($stamp) | ConvertFrom-Json
    if ($metadata.sourceCommit -cne $Commit -or $metadata.platform -cne 'win32' -or $metadata.architecture -cne 'x64' -or
        $metadata.applicationFiles -ne @($hashes.Keys | Where-Object { $_.StartsWith('win-unpacked/') }).Count) {
        throw 'The candidate manifest does not match this Windows x64 commit.'
    }
    return ,$hashes
}

$root = 'D:\SupervisorWorkspace'
if ($AcceptanceRoot) {
    if ($AcceptanceRoot -cnotmatch '\AD:\\Codex-Development\\Builds\\sw-production-admission-[0-9a-f]{32}\z') {
        throw 'Use a new isolated admission acceptance directory beneath D:\Codex-Development\Builds.'
    }
    $root = $AcceptanceRoot
}
$versions = Join-Path $root 'App\Versions'
$version = Join-Path $versions $Commit
$executable = Join-Path $version 'SupervisorWorkspace-MVP.exe'

if ($Operation -eq 'Install') {
    if (!$PackageRoot) { throw 'Provide -PackageRoot for Install.' }
    $package = [IO.Path]::GetFullPath($PackageRoot)
    $hashes = Manifest-Files $package
    foreach ($relativeDirectory in @('App\Versions', 'Profiles\Staging', 'Profiles\Synthetic', 'Exports', 'Logs\Crash')) {
        Require-Directory (Join-Path $root $relativeDirectory) $true
    }
    if (Test-Path -LiteralPath $version) { throw 'This version is already present. Existing versions are kept.' }
    $staged = Join-Path $versions ('.staging-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staged | Out-Null
    foreach ($key in $hashes.Keys | Where-Object { $_.StartsWith('win-unpacked/') }) {
        $subpath = $key.Substring('win-unpacked/'.Length).Replace('/', '\')
        $destination = Join-Path $staged $subpath
        Require-Directory ([IO.Path]::GetDirectoryName($destination)) $true
        [IO.File]::Copy((Join-Path $package $key.Replace('/', '\')), $destination, $false)
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash -ine $hashes[$key]) {
            throw "Installed file does not match the verified package: $subpath"
        }
    }
    foreach ($metadata in @('build-info.json', 'SHA256SUMS.txt')) {
        [IO.File]::Copy((Join-Path $package $metadata), (Join-Path $staged $metadata), $false)
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $staged 'build-info.json')).Hash -ine $hashes['build-info.json']) {
        throw 'Installed build metadata changed during copy.'
    }
    [IO.Directory]::Move($staged, $version)
    Write-Output $executable
    return
}

Require-Directory $version
$null = Require-File $executable

if ($Operation -eq 'CreateShortcut') {
    $owner = Join-Path $root 'Profiles\Primary'
    Require-Directory $owner
    $null = Require-File (Join-Path $owner 'production-primary.initialized')
    $folder = if ($AcceptanceRoot) { Join-Path $root 'Shortcuts' } else { [Environment]::GetFolderPath('DesktopDirectory') }
    Require-Directory $folder ([bool] $AcceptanceRoot)
    $link = Join-Path $folder 'Supervisor Workspace v0.2.lnk'
    if (Test-Path -LiteralPath $link) { throw 'The shortcut already exists. Keep it until an authorised upgrade or rollback.' }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.TargetPath = $executable
    $shortcut.WorkingDirectory = $version
    $shortcut.Description = 'Supervisor Workspace v0.2'
    $shortcut.Save()
    Write-Output $link
    return
}

if (!$InputPath) { throw 'Provide -InputPath for this operation.' }
$commands = @{ PrepareLegacy = 'prepare-legacy'; ActivatePrimary = 'activate-primary'; ReviewOperations = 'review-operations' }
$bindings = @{
    ELECTRON_RUN_AS_NODE = '1'
    SW_ADMISSION_MODULE = (Join-Path $version 'resources\app.asar\build\production-admission.js')
    SW_ADMISSION_ACTION = $commands[$Operation]
    SW_ADMISSION_INPUT = [IO.Path]::GetFullPath($InputPath)
    SW_ADMISSION_DIGEST = $ExpectedSha256
}
$saved = @{}
try {
    foreach ($key in $bindings.Keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $bindings[$key], 'Process')
    }
    # A pipeline makes Windows PowerShell wait for this GUI-subsystem executable.
    & $executable -e 'require(process.env.SW_ADMISSION_MODULE).runProductionCommand(process.execPath, process.env.SW_ADMISSION_ACTION, process.env.SW_ADMISSION_INPUT, process.env.SW_ADMISSION_DIGEST || String()).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e.message); process.exitCode = 1; })' |
        ForEach-Object { $_ }
    if ($LASTEXITCODE -ne 0) { throw 'Admission failed. Retain source data, copies and logs.' }
} finally {
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
}
