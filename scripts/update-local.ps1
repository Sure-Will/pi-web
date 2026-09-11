#Requires -Version 7.0
param(
    [ValidateSet('Prepare','Install','Update')][string]$Action = 'Update',
    [string]$InstallRoot = 'D:\Pi'
)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path $PSScriptRoot -Parent
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$cacheRoot = Join-Path $InstallRoot 'cache\pi-web-local-build'
$appRoot = Join-Path $InstallRoot 'app\node_modules\@agegr\pi-web'
$launcher = Join-Path $InstallRoot 'Pi-Web.ps1'
$dataRoot = Join-Path $InstallRoot 'data'
$url = 'http://127.0.0.1:30141'

function Assert-InRoot([string]$Target, [string]$Root) {
    $absolute = [IO.Path]::GetFullPath($Target)
    if (!$absolute.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Path outside expected root: $absolute" }
    $cursor = $absolute
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and (Get-Item -LiteralPath $cursor).LinkType) { throw "Deployment path is a link: $cursor" }
        $cursor = Split-Path $cursor -Parent
    }
}
function Invoke-Launcher([string]$Mode) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -Action $Mode -NoOpen
    if ($LASTEXITCODE -ne 0) { throw "Pi Web $Mode failed." }
}
function Is-Listening {
    return @(Get-NetTCPConnection -LocalPort 30141 -State Listen -ErrorAction SilentlyContinue).Count -gt 0
}
function Assert-Idle {
    if (!(Is-Listening)) { return }
    $running = Invoke-RestMethod "$url/api/agent/running" -TimeoutSec 10
    if (@($running.runningSessionIds).Count -gt 0) { throw 'Pi Web has active work. Candidate is preserved; run update:local with -Action Install when idle.' }
}
function Get-CoreHashes {
    return @(Get-ChildItem -LiteralPath $dataRoot -Recurse -File | Where-Object {
        $_.Name -in @('auth.json','settings.json','models.json','models-store.json') -or $_.Extension -eq '.jsonl'
    } | Sort-Object FullName | ForEach-Object { [PSCustomObject]@{Path=$_.FullName;Sha256=(Get-FileHash -LiteralPath $_.FullName).Hash} })
}
function Assert-RuntimeMatches {
    if (!(Test-Path -LiteralPath $launcher)) { throw 'Managed Pi Web launcher is missing.' }
    if ((Get-FileHash (Join-Path $sourceRoot 'package-lock.json')).Hash -ne (Get-FileHash (Join-Path $appRoot 'npm-shrinkwrap.json')).Hash) { throw 'Dependency lock changed. This command only updates builds with unchanged dependencies; prepare a full package update.' }
    foreach ($folder in @('public','bin')) {
        $sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $sourceRoot $folder) -Recurse -File)
        $installedFiles = @(Get-ChildItem -LiteralPath (Join-Path $appRoot $folder) -Recurse -File)
        if ($sourceFiles.Count -ne $installedFiles.Count) { throw "$folder changed; use a full package update." }
        foreach ($file in $sourceFiles) {
            $relative = [IO.Path]::GetRelativePath($sourceRoot, $file.FullName)
            $target = Join-Path $appRoot $relative
            $same = (Test-Path -LiteralPath $target) -and ((Get-FileHash -LiteralPath $file.FullName).Hash -eq (Get-FileHash -LiteralPath $target).Hash)
            if (!$same -and $file.Extension -in @('.js','.mjs','.md','.json')) {
                $same = (Test-Path -LiteralPath $target) -and ([IO.File]::ReadAllText($file.FullName).Replace("`r`n","`n") -ceq [IO.File]::ReadAllText($target).Replace("`r`n","`n"))
            }
            if (!$same) { throw "$relative changed; use a full package update." }
        }
    }
    if ([IO.File]::ReadAllText((Join-Path $sourceRoot 'next.config.ts')).Replace("`r`n","`n") -cne [IO.File]::ReadAllText((Join-Path $appRoot 'next.config.ts')).Replace("`r`n","`n")) { throw 'Runtime configuration changed; use a full package update.' }
    $pkg = Get-Content (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json
    foreach ($dependency in $pkg.dependencies.PSObject.Properties) {
        $sourceVersion = (Get-Content (Join-Path $sourceRoot "node_modules\$($dependency.Name)\package.json") -Raw | ConvertFrom-Json).version
        $installedVersion = (Get-Content (Join-Path $appRoot "node_modules\$($dependency.Name)\package.json") -Raw | ConvertFrom-Json).version
        if ($sourceVersion -ne $installedVersion) { throw "Runtime dependency mismatch: $($dependency.Name)" }
    }
}

$lockHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($InstallRoot.ToLowerInvariant()))).Substring(0,16)
$updateMutex = [Threading.Mutex]::new($false, "Local\PiWebUpdate-$lockHash")
if (!$updateMutex.WaitOne(0)) { $updateMutex.Dispose(); throw 'Another local update is already in progress.' }
try {
Assert-RuntimeMatches
if ($Action -ne 'Install') {
    & node (Join-Path $PSScriptRoot 'local-build.mjs') $cacheRoot
    if ($LASTEXITCODE -ne 0) { throw 'Candidate preparation failed; installed service was not stopped.' }
}
if ($Action -eq 'Prepare') { return }
& node (Join-Path $PSScriptRoot 'local-build.mjs') $cacheRoot --check
if ($LASTEXITCODE -ne 0) { throw 'Candidate no longer matches source.' }
$ready = Get-Content -LiteralPath (Join-Path $cacheRoot 'ready.json') -Raw | ConvertFrom-Json
$sourceNext = Join-Path $cacheRoot 'workspace\.next'
$liveNext = Join-Path $appRoot '.next'
if (([IO.File]::ReadAllText((Join-Path $liveNext 'BUILD_ID'))).Trim() -eq $ready.buildId) {
    Write-Output 'This build is already installed; no restart needed.'
    return
}
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
$backupRoot = Join-Path $InstallRoot "backups\pi-web-$stamp"
$stagedNext = Join-Path $appRoot ".next-staged-$stamp"
$savedNext = Join-Path $backupRoot 'previous-next'
$failedNext = Join-Path $backupRoot 'failed-next'
foreach ($target in @($liveNext,$stagedNext,$savedNext,$failedNext)) { Assert-InRoot $target $InstallRoot }
if ((Test-Path $backupRoot) -or (Test-Path $stagedNext)) { throw 'Deployment destination already exists.' }
New-Item -ItemType Directory -Path $backupRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $cacheRoot 'ready.json') -Destination $backupRoot
& robocopy $sourceNext $stagedNext /E /XD cache dev /XF *.map /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NP *> (Join-Path $backupRoot 'stage.log')
if ($LASTEXITCODE -ge 8) { throw 'Staging failed; installed service was not stopped.' }
foreach ($file in Get-ChildItem -LiteralPath $stagedNext -Recurse -File) {
    $relative = [IO.Path]::GetRelativePath($stagedNext, $file.FullName)
    if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath (Join-Path $sourceNext $relative)).Hash) { throw "Staged file differs: $relative" }
}
& node (Join-Path $PSScriptRoot 'local-build.mjs') $cacheRoot --check
if ($LASTEXITCODE -ne 0) { throw 'Source changed during staging; installed service was not stopped.' }
$latest = Get-Content -LiteralPath (Join-Path $cacheRoot 'ready.json') -Raw | ConvertFrom-Json
if ($latest.fingerprint -ne $ready.fingerprint -or $latest.buildId -ne $ready.buildId) { throw 'Candidate changed during staging; installed service was not stopped.' }
Assert-RuntimeMatches
Assert-Idle
$moved = $false
try {
Invoke-Launcher Stop
if (Is-Listening) { throw 'Port is still occupied; installation was not changed.' }
$coreBefore = Get-CoreHashes
$coreBefore | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $backupRoot 'core-data-hashes.json') -Encoding utf8
$installState = Join-Path $InstallRoot 'install-state.json'
Copy-Item -LiteralPath $installState -Destination $backupRoot
    Move-Item -LiteralPath $liveNext -Destination $savedNext
    $moved = $true
    Move-Item -LiteralPath $stagedNext -Destination $liveNext
    Invoke-Launcher Start
    $sessions = Invoke-RestMethod "$url/api/sessions?force=1" -TimeoutSec 15
    $null = Invoke-WebRequest $url -TimeoutSec 15
    if (([IO.File]::ReadAllText((Join-Path $liveNext 'BUILD_ID'))).Trim() -ne $ready.buildId) { throw 'Installed build identity mismatch.' }
    if (($coreBefore | ConvertTo-Json -Compress) -ne ((Get-CoreHashes) | ConvertTo-Json -Compress)) { throw 'Core data hashes changed.' }
} catch {
    $failure = $_
    Invoke-Launcher Stop
    if (Is-Listening) { throw 'Service is still listening; inspect the backup before rollback.' }
    if ($moved) {
        if (Test-Path -LiteralPath $liveNext) { Move-Item -LiteralPath $liveNext -Destination $failedNext }
        Move-Item -LiteralPath $savedNext -Destination $liveNext
    }
    Invoke-Launcher Start
    throw $failure
}
$manifest = [ordered]@{BuildId="local-$stamp";NextBuildId=$ready.buildId;InstalledAt=(Get-Date).ToString('o');Source=$sourceRoot;Fingerprint=$ready.fingerprint;BuildSeconds=$ready.elapsedSeconds;Backup=$backupRoot;SessionCount=@($sessions.sessions).Count;PreservedCoreFiles=$coreBefore.Count}
$manifest | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $backupRoot 'installed.json') -Encoding utf8
$state = Get-Content $installState -Raw | ConvertFrom-Json
$state | Add-Member -NotePropertyName PiWebLocalBuild -NotePropertyValue $manifest -Force
$state | ConvertTo-Json -Depth 12 | Set-Content $installState -Encoding utf8
Write-Output "Pi Web updated: $url. Backup: $backupRoot"
} finally {
    $updateMutex.ReleaseMutex()
    $updateMutex.Dispose()
}
