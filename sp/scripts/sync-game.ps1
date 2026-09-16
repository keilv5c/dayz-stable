# ============================================================================
#  sync-game.ps1 -- copy the 2.2.6 game payload INTO the repo (sp/web)
# ----------------------------------------------------------------------------
#  WHY THIS EXISTS
#    This git repo's root is Minidayz-WebRTC/, but the game lives OUTSIDE it
#    (../Minidayz-2.2.6-main/Minidayz-2.2.6-main). GitHub Actions only checks
#    out the repository, so it cannot see that directory. The game payload must
#    therefore be COMMITTED into the repo, and sp/web/ is exactly that copy.
#
#  WHEN TO RUN
#    After changing the game (localisation, data.js, images, ...) run this, then
#    `git add sp/web` and commit.
#
#  USAGE
#    powershell -NoProfile -ExecutionPolicy Bypass -File sp/scripts/sync-game.ps1
#    powershell ... -File sp/scripts/sync-game.ps1 -Source "D:\path\to\game"
#
#  NOTE: this file is deliberately pure ASCII. Windows PowerShell 5.1 reads
#        BOM-less files using the ANSI code page, which corrupts non-ASCII text
#        and breaks parsing. Keep it ASCII-only. Chinese docs live in
#        sp/README-SP.md instead.
# ============================================================================
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$Source   = ''
)

$ErrorActionPreference = 'Stop'

# Resolve paths inside the body: default-value expressions are evaluated very
# early on Windows PowerShell 5.1 and $PSScriptRoot can still be empty there.
if (-not $RepoRoot) {
    $here = $PSScriptRoot
    if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $RepoRoot = (Resolve-Path (Join-Path $here '..\..')).Path
}

if (-not $Source) {
    # The external 2.2.6 folder, one level above the repo root.
    $Source = Join-Path (Split-Path $RepoRoot -Parent) 'Minidayz-2.2.6-main\Minidayz-2.2.6-main'
}

$Dst = Join-Path $RepoRoot 'sp\web'

Write-Host '=== sync game payload -> sp/web ===' -ForegroundColor Cyan
Write-Host "  source: $Source"
Write-Host "  dest  : $Dst"
Write-Host ''

if (-not (Test-Path (Join-Path $Source 'index.html'))) {
    throw "No index.html in source: $Source  (pass -Source to point at the game folder)"
}

# --- sanity: the game must be localised AND have MDZ START removed ---
$dataPath = Join-Path $Source 'data.js'
$raw = [System.IO.File]::ReadAllText($dataPath, [System.Text.Encoding]::UTF8)
if ($raw.Contains([char]0x2606)) {
    throw 'data.js still contains the star glyph (MDZ START not removed). Fix the game first.'
}
$uiPath = Join-Path $Source 'l_eng_ui.xml'
$uiTxt = [System.IO.File]::ReadAllText($uiPath, [System.Text.Encoding]::UTF8)
$cjk = ([regex]::Matches($uiTxt, '[\u4e00-\u9fff]')).Count
if ($cjk -lt 1000) {
    throw "l_eng_ui.xml only has $cjk CJK chars - the Chinese localisation is not in place."
}
Write-Host "  [OK] game payload verified (no MDZ START, $cjk CJK chars in UI)" -ForegroundColor Green
Write-Host ''

# --- copy, excluding backups and markdown notes ---
$excludeDirs = @('_backup_orig')

if (Test-Path $Dst) { Remove-Item $Dst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Dst | Out-Null

$count = 0
$bytes = 0
$baseLen = $Source.Length
Get-ChildItem $Source -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($baseLen).TrimStart('\')
    $top = $rel.Split('\')[0]
    if ($excludeDirs -contains $top) { return }
    if ($_.Extension -eq '.md') { return }
    $target = Join-Path $Dst $rel
    $dir = Split-Path $target -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item $_.FullName $target -Force
    $count++
    $bytes += $_.Length
}

Write-Host "  copied $count files, $([math]::Round($bytes/1MB,1)) MB" -ForegroundColor Green

# --- verify required files landed ---
$required = @('index.html','data.js','c2runtime.js','l_eng_ui.xml','l_eng_items.xml','l_eng_log.xml','l_eng_new.xml','offline.js','sw.js')
foreach ($f in $required) {
    if (-not (Test-Path (Join-Path $Dst $f))) { throw "after sync, missing: $f" }
}
Write-Host '  [OK] required files present' -ForegroundColor Green

# --- size warning (this goes into git) ---
$total = (Get-ChildItem $Dst -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ''
Write-Host "sp/web total: $([math]::Round($total/1MB,1)) MB" -ForegroundColor Yellow
Write-Host 'Remember: git add sp/web && git commit (these files are tracked).' -ForegroundColor Yellow
