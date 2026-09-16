# ============================================================================
#  prepare.ps1 -- build the "single-player" iOS bundle tree (Windows + CI)
# ----------------------------------------------------------------------------
#  WHAT IT DOES
#    1. copy the game payload (localised 2.2.6, MDZ START removed) into
#       sp/ios/App/App/public
#    2. copy the Capacitor iOS runtime into sp/ios/App/node_modules so the
#       hand-written Podfile can reference it locally
#    3. generate sp/ios/App/App/capacitor.config.json
#    4. run transform-web.js (disable Service Worker, localise the startup alert)
#
#  WHY NOT `npx cap copy`
#    This is the single-player build and does NOT need the MLKit barcode plugin.
#    Going through the Capacitor CLI makes it rewrite the Podfile from the
#    plugin list in package.json and pulls MLKit back in (MLKit 8.x requires
#    Xcode >= 16, downloads hundreds of MB and slows the build a lot).
#    So the Podfile is written by hand and only depends on Capacitor itself.
#
#  USAGE
#    powershell -NoProfile -ExecutionPolicy Bypass -File sp/scripts/prepare.ps1
#    powershell ... -File sp/scripts/prepare.ps1 -GameDir "D:\path\to\game"
#
#  NOTE: this file is deliberately pure ASCII (Windows PowerShell 5.1 reads
#        BOM-less files as ANSI and would corrupt non-ASCII text). Chinese
#        documentation lives in sp/README-SP.md.
# ============================================================================
[CmdletBinding()]
param(
    # Root of THIS git repo (= Minidayz-WebRTC/, the parent of sp/)
    [string]$RepoRoot = '',
    [string]$GameDir  = '',
    [switch]$SkipNodeModules
)

$ErrorActionPreference = 'Stop'

# Resolve paths inside the body: default-value expressions are evaluated very
# early on Windows PowerShell 5.1 and $PSScriptRoot can still be empty there.
if (-not $RepoRoot) {
    $here = $PSScriptRoot
    if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $RepoRoot = (Resolve-Path (Join-Path $here '..\..')).Path
}

$SpRoot     = Join-Path $RepoRoot 'sp'
$IosApp     = Join-Path $SpRoot 'ios\App'
$PublicDir  = Join-Path $IosApp 'App\public'
$NodeModDir = Join-Path $IosApp 'node_modules\@capacitor'

if (-not $GameDir) {
    # Prefer the in-repo copy (sp/web) - it is the only one that exists on CI.
    # Local dev may not have synced yet, so fall back to the external folder.
    $inRepo = Join-Path $SpRoot 'web'
    if (Test-Path (Join-Path $inRepo 'index.html')) {
        $GameDir = $inRepo
    } else {
        $GameDir = Join-Path (Split-Path $RepoRoot -Parent) 'Minidayz-2.2.6-main\Minidayz-2.2.6-main'
    }
}

Write-Host '=== prepare single-player iOS build tree ===' -ForegroundColor Cyan
Write-Host "  repo root : $RepoRoot"
Write-Host "  game dir  : $GameDir"
Write-Host "  public    : $PublicDir"
Write-Host ''

# ---------------------------------------------------------------- preflight
if (-not (Test-Path (Join-Path $GameDir 'index.html'))) {
    throw "Wrong game dir, no index.html: $GameDir"
}
foreach ($f in 'data.js', 'c2runtime.js', 'l_eng_ui.xml') {
    if (-not (Test-Path (Join-Path $GameDir $f))) { throw "game dir is missing $f" }
}

# data.js must no longer contain the star glyph (MDZ START removed)
$raw = [System.IO.File]::ReadAllText((Join-Path $GameDir 'data.js'), [System.Text.Encoding]::UTF8)
if ($raw.Contains([char]0x2606)) {
    throw "data.js still contains the star glyph (MDZ START not removed)"
}
Write-Host '  [OK] data.js has no MDZ START' -ForegroundColor Green

# localisation must be in place
$uiTxt = [System.IO.File]::ReadAllText((Join-Path $GameDir 'l_eng_ui.xml'), [System.Text.Encoding]::UTF8)
$cjk = ([regex]::Matches($uiTxt, '[\u4e00-\u9fff]')).Count
if ($cjk -lt 1000) { throw "l_eng_ui.xml has too few CJK chars ($cjk) - localisation missing?" }
Write-Host "  [OK] l_eng_ui.xml has $cjk CJK chars" -ForegroundColor Green

# ---------------------------------------------------------------- 1. game payload
Write-Host ''
Write-Host '[1/4] copy game payload ...' -ForegroundColor Cyan
if (Test-Path $PublicDir) { Remove-Item $PublicDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $PublicDir | Out-Null

$excludeDirs = @('_backup_orig')
$count = 0
$baseLen = $GameDir.Length
Get-ChildItem $GameDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($baseLen).TrimStart('\')
    $top = $rel.Split('\')[0]
    if ($excludeDirs -contains $top) { return }
    if ($_.Extension -eq '.md') { return }
    $dst = Join-Path $PublicDir $rel
    $dir = Split-Path $dst -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item $_.FullName $dst -Force
    $count++
}
Write-Host "  copied $count files" -ForegroundColor Green

# ---------------------------------------------------------------- 2. Capacitor runtime
if (-not $SkipNodeModules) {
    Write-Host ''
    Write-Host '[2/4] copy Capacitor runtime (for the local Podfile path) ...' -ForegroundColor Cyan
    $srcCap = Join-Path $RepoRoot 'node_modules\@capacitor\ios'
    if (-not (Test-Path $srcCap)) {
        throw "Cannot find $srcCap - run 'npm ci' in the repo root first."
    }
    $dstCap = Join-Path $NodeModDir 'ios'
    if (Test-Path $dstCap) { Remove-Item $dstCap -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dstCap | Out-Null
    Copy-Item (Join-Path $srcCap '*') $dstCap -Recurse -Force
    $ver = (Get-Content (Join-Path $srcCap 'package.json') -Raw | ConvertFrom-Json).version
    Write-Host "  @capacitor/ios $ver" -ForegroundColor Green
} else {
    Write-Host ''
    Write-Host '[2/4] skipped Capacitor runtime copy (-SkipNodeModules)' -ForegroundColor Yellow
}

# ---------------------------------------------------------------- 3. web transform
Write-Host ''
Write-Host '[3/4] transform web assets (disable SW, localise startup alert) ...' -ForegroundColor Cyan
& node (Join-Path $PSScriptRoot 'transform-web.js') $PublicDir
if ($LASTEXITCODE -ne 0) { throw 'transform-web.js failed' }

# ---------------------------------------------------------------- 4. capacitor config
Write-Host ''
Write-Host '[4/4] write capacitor.config.json ...' -ForegroundColor Cyan
$cfg = [ordered]@{
    appId             = 'com.mdz.minidayz.sp'
    appName           = 'Mini DAYZ'
    webDir            = 'public'
    bundledWebRuntime = $false
    ios               = [ordered]@{
        contentInset                       = 'never'
        limitsNavigationsToAppBoundDomains = $false
        allowsLinkPreview                  = $false
    }
    server            = [ordered]@{ iosScheme = 'capacitor' }
}
$cfgPath = Join-Path $IosApp 'App\capacitor.config.json'
# IMPORTANT: write UTF-8 WITHOUT BOM. Windows PowerShell 5.1's
# `Set-Content -Encoding UTF8` prepends a BOM, and Capacitor's JSON parser
# chokes on it (Unexpected token) - the app would fail to boot.
$json = $cfg | ConvertTo-Json -Depth 6
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($cfgPath, $json, $utf8NoBom)
# verify it really parses and has no BOM
$bytes = [System.IO.File]::ReadAllBytes($cfgPath)
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw 'capacitor.config.json still has a UTF-8 BOM - Capacitor would fail to parse it'
}
$null = $json | ConvertFrom-Json
Write-Host "  wrote $cfgPath (UTF-8 no BOM, JSON valid)" -ForegroundColor Green

# ---------------------------------------------------------------- summary
Write-Host ''
Write-Host '=== done ===' -ForegroundColor Cyan
$files = Get-ChildItem $PublicDir -Recurse -File
$size  = [math]::Round((($files | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "  public/ : $($files.Count) files, $size MB"
Write-Host "  index.html present      : $(Test-Path (Join-Path $PublicDir 'index.html'))"
Write-Host "  capacitor.config.json   : $(Test-Path $cfgPath)"
Write-Host "  multiplayer leftovers   : mdz_p2p.js = $(Test-Path (Join-Path $PublicDir 'mdz_p2p.js')) (must be False)"
if (Test-Path (Join-Path $PublicDir 'mdz_p2p.js')) { throw 'multiplayer scripts leaked into the single-player bundle' }
