$ErrorActionPreference = "Stop"

# Locate config.ps1 in parent or sibling surfacesrv directory
$cfgPath = Join-Path $PSScriptRoot "..\surfacesrv\config.ps1"
if (-not (Test-Path $cfgPath)) {
    $root = $PSScriptRoot
    while ($root -and -not (Test-Path (Join-Path $root "config.ps1"))) {
        $root = Split-Path $root -Parent
    }
    if ($root) { $cfgPath = Join-Path $root "config.ps1" }
}
. $cfgPath

$targetDir = "/var/home/shu/services/samplevis"
$sshArgs = if ($cfgHomeServerKeyPath -and (Test-Path $cfgHomeServerKeyPath)) { @("-i", $cfgHomeServerKeyPath) } else { @() }

Write-Host "1. Uploading SampleVis service files to home server..." -ForegroundColor Cyan
ssh @sshArgs $cfgHomeServerUser@$cfgHomeServerIp "mkdir -p $targetDir/src/parsers $targetDir/src/media $targetDir/src/social $targetDir/public/js $targetDir/public/vendor $targetDir/data/anime-clips $targetDir/data/presets/meadows $targetDir/data/uploads $targetDir/data/exports"

scp @sshArgs (Join-Path $PSScriptRoot "Dockerfile") (Join-Path $PSScriptRoot "docker-compose.yml") (Join-Path $PSScriptRoot "package.json") (Join-Path $PSScriptRoot "package-lock.json") (Join-Path $PSScriptRoot "server.js") (Join-Path $PSScriptRoot "deploy.sh") "${cfgHomeServerUser}@${cfgHomeServerIp}:$targetDir/"
scp @sshArgs -r (Join-Path $PSScriptRoot "src\*") "${cfgHomeServerUser}@${cfgHomeServerIp}:$targetDir/src/"
scp @sshArgs -r (Join-Path $PSScriptRoot "public\*") "${cfgHomeServerUser}@${cfgHomeServerIp}:$targetDir/public/"
scp @sshArgs -r (Join-Path $PSScriptRoot "data\presets\meadows\*") "${cfgHomeServerUser}@${cfgHomeServerIp}:$targetDir/data/presets/meadows/"
if (Test-Path (Join-Path $PSScriptRoot "data\anime-library.json")) {
    scp @sshArgs (Join-Path $PSScriptRoot "data\anime-library.json") "${cfgHomeServerUser}@${cfgHomeServerIp}:$targetDir/data/"
}
if (Test-Path (Join-Path $PSScriptRoot "data\anime-clips\*.mp4")) {
    scp @sshArgs (Join-Path $PSScriptRoot "data\anime-clips\*.mp4") "${cfgHomeServerUser}@${cfgHomeServerIp}:$targetDir/data/anime-clips/"
}

Write-Host "`n2. Executing remote Docker deployment..." -ForegroundColor Cyan
ssh @sshArgs $cfgHomeServerUser@$cfgHomeServerIp "sed -i 's/\r$//' $targetDir/deploy.sh && bash $targetDir/deploy.sh"

if ($LASTEXITCODE -ne 0) {
    Write-Error "Remote deployment failed."
    exit 1
}
Write-Host "`nSampleVis deployed on port 3450!" -ForegroundColor Green

