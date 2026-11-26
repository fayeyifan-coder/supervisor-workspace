param([Parameter(Mandatory=$true)][string]$SourceRoot,[Parameter(Mandatory=$true)][string]$OutputRoot,[Parameter(Mandatory=$true)][ValidatePattern('\A[0-9a-f]{40}\z')][string]$SourceCommit)
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath($SourceRoot)
$output=[IO.Path]::GetFullPath($OutputRoot)
if($source.StartsWith('D:\SupervisorWorkspace\',[StringComparison]::OrdinalIgnoreCase) -or $output.StartsWith('D:\SupervisorWorkspace\',[StringComparison]::OrdinalIgnoreCase)){throw 'Formal installation/data roots are forbidden'}
if(Test-Path -LiteralPath $output){throw 'Output must be a fresh directory'}
$tools=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$toolingCommit=(& git -C $tools rev-parse HEAD).Trim()
if((& git -C $tools status --porcelain)){throw 'Tooling worktree is not clean'}
if((& git -C $source rev-parse HEAD).Trim() -cne $SourceCommit -or (& git -C $source status --porcelain)){throw 'Source identity/worktree mismatch'}
Push-Location -LiteralPath $source
$saved=@{}
try{
 New-Item -ItemType Directory -Path $output -ErrorAction Stop|Out-Null
 $appInput=Join-Path $output 'app-input';New-Item -ItemType Directory -Path $appInput|Out-Null
 Copy-Item -LiteralPath 'build','dist' -Destination $appInput -Recurse -ErrorAction Stop
 $package=Get-Content -LiteralPath 'package.json' -Raw|ConvertFrom-Json
 [ordered]@{name=$package.name;version=$package.version;description=$package.description;author=$package.author;main=$package.main}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $appInput 'package.json') -Encoding utf8NoBOM
 $lock=Get-Content -LiteralPath 'package-lock.json' -Raw|ConvertFrom-Json -AsHashtable
 $electronVersion=$lock.packages['node_modules/electron'].version
 & npm.cmd run pack:win:dir -- "--config.directories.app=$appInput" "--config.directories.output=$output" "--config.electronVersion=$electronVersion"
 if($LASTEXITCODE -ne 0){throw 'Pack failed'}
 New-Item -ItemType Directory -Path (Join-Path $output 'deploy')|Out-Null
 Copy-Item -LiteralPath 'deploy/Production-Admission.ps1' -Destination (Join-Path $output 'deploy')
 $bindings=@{MVP_PORTABLE_ROOT=$output;MVP_HEAD_SHA=$SourceCommit;MVP_TOOLING_SHA=$toolingCommit;MVP_ELECTRON_FILE_VERSION=(Get-Item -LiteralPath (Join-Path $output 'win-unpacked\SupervisorWorkspace-MVP.exe')).VersionInfo.ProductVersion}
 foreach($key in $bindings.Keys){$saved[$key]=[Environment]::GetEnvironmentVariable($key,'Process');[Environment]::SetEnvironmentVariable($key,$bindings[$key],'Process')}
 & node (Join-Path $PSScriptRoot 'verify-portable.cjs')
 if($LASTEXITCODE -ne 0){throw 'Package verification failed'}
 if((& git -C $source status --porcelain)){throw 'Source changed during package'}
 Write-Output "Verified package at $output"
}finally{foreach($key in $saved.Keys){[Environment]::SetEnvironmentVariable($key,$saved[$key],'Process')};Pop-Location}
