param([Parameter(Mandatory=$true)][string]$SourceRoot,[Parameter(Mandatory=$true)][ValidatePattern('\A[0-9a-f]{40}\z')][string]$SourceCommit,[Parameter(Mandatory=$true)][string]$OutputRoot)
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath($SourceRoot);$out=[IO.Path]::GetFullPath($OutputRoot)
if($source.StartsWith('D:\SupervisorWorkspace\',[StringComparison]::OrdinalIgnoreCase) -or $out.StartsWith('D:\SupervisorWorkspace\',[StringComparison]::OrdinalIgnoreCase) -or $out.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Use isolated source and output outside the source tree; no formal paths'}
if(Test-Path -LiteralPath $out){throw 'Output already exists; keep evidence and use a fresh directory'}
if((& git -C $source rev-parse HEAD).Trim() -cne $SourceCommit -or (& git -C $source status --porcelain)){throw 'Source is not the fixed clean checkout'}
if((& node --version).Trim() -cne 'v24.19.0' -or (& npm.cmd --version).Trim() -cne '11.17.0'){throw 'Locked development Node/npm required'}
New-Item -ItemType Directory -Path $out|Out-Null
$temp=if($env:GITHUB_ACTIONS -ceq 'true'){$env:RUNNER_TEMP}else{'D:\Codex-Development\Temp\supervisor-workspace-mvp\runtime'}
if(!$temp){throw 'Approved temporary root unavailable'}
New-Item -ItemType Directory -Path $temp -Force|Out-Null
$saved=@{};foreach($key in @('TEMP','TMP','TMPDIR')){$saved[$key]=[Environment]::GetEnvironmentVariable($key,'Process');[Environment]::SetEnvironmentVariable($key,$temp,'Process')}
function Run-Gate([string]$Name,[string]$Program,[string[]]$Arguments){& $Program @Arguments 2>&1|Tee-Object -FilePath (Join-Path $out ($Name+'.log'));if($LASTEXITCODE -ne 0){throw "Gate failed: $Name"}}
Push-Location -LiteralPath $source
try{
 Run-Gate 'install' 'npm.cmd' @('ci')
 Run-Gate 'typecheck' 'npm.cmd' @('run','typecheck')
 Run-Gate 'tests' 'npm.cmd' @('test')
 Run-Gate 'build' 'npm.cmd' @('run','build')
 & (Join-Path $PSScriptRoot 'Build-Portable.ps1') -SourceRoot $source -OutputRoot (Join-Path $out 'portable') -SourceCommit $SourceCommit 2>&1|Tee-Object -FilePath (Join-Path $out 'package.log')
 Run-Gate 'packaged-smoke' 'node' @((Join-Path $source 'scripts\smoke-electron.cjs'),(Join-Path $out 'portable\win-unpacked\SupervisorWorkspace-MVP.exe'))
 if((& git -C $source status --porcelain)){throw 'Source changed during build'}
 $zip=Join-Path $out 'candidate-win-x64.zip'
 Compress-Archive -LiteralPath (Join-Path $out 'portable\win-unpacked'),(Join-Path $out 'portable\deploy'),(Join-Path $out 'portable\build-info.json'),(Join-Path $out 'portable\SHA256SUMS.txt') -DestinationPath $zip -CompressionLevel Optimal
 # Read every manifest member out of the ZIP and verify the delivered bytes.
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 $archive=[IO.Compression.ZipFile]::OpenRead($zip)
 try{foreach($line in [IO.File]::ReadAllLines((Join-Path $out 'portable\SHA256SUMS.txt'))){if($line -cnotmatch '\A([0-9a-f]{64}) \*(.+)\z'){throw 'Bad manifest'};$hash=$Matches[1];$name=$Matches[2];$entry=$archive.GetEntry($name);if(!$entry){throw 'ZIP member missing'};$stream=$entry.Open();try{$sha=[Security.Cryptography.SHA256]::Create();if([Convert]::ToHexString($sha.ComputeHash($stream)).ToLower() -cne $hash){throw 'ZIP member differs'}}finally{$stream.Dispose();$sha.Dispose()}}}finally{$archive.Dispose()}
 $origin=if($env:GITHUB_ACTIONS -ceq 'true'){'github-actions'}else{'local-controlled'}
 $result=[ordered]@{sourceCommit=$SourceCommit;toolingCommit=(& git -C (Join-Path $PSScriptRoot '..') rev-parse HEAD).Trim();origin=$origin;engineeringValidation='PASS';archive=$zip;bytes=(Get-Item -LiteralPath $zip).Length;sha256=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower();formalReleaseAuthorized=$false;remainingGate='Product-specific isolation acceptance and backup/rollback evidence must match this package, then obtain explicit deployment approval.'}
 $result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $out 'candidate-identity.json') -Encoding utf8
 $result|ConvertTo-Json
}finally{foreach($key in $saved.Keys){[Environment]::SetEnvironmentVariable($key,$saved[$key],'Process')};Pop-Location}
