<#
.SYNOPSIS
  One command to set up, verify and run AI Fantasy Studio (CINEMA-AI) on Windows,
  ending with a REAL generated film and a verification report.

.DESCRIPTION
  Run from the repository root in PowerShell:

      powershell -ExecutionPolicy Bypass -File scripts\windows\run-cinema-ai.ps1

  What it does (stops with an exact reason if a step needs you):
    1. Checks Node.js (>= 22.9), npm, Git, Docker Desktop, FFmpeg/FFprobe.
       Missing tools are installed with winget (Windows will show a UAC prompt -
       approve it; the script never asks for your password).
    2. Starts Docker Desktop if needed, then Postgres + Redis with docker compose.
    3. Creates .env from .env.example (gitignored). API keys are read from your
       environment variables if already set, otherwise typed in hidden. Keys are
       never printed - only masked.
    4. npm ci, DB migrations, lint, typecheck, unit/integration tests, build.
    5. Validates every provider against its live API (npm run providers:check).
    6. Runs the complete pipeline on examples\sample-story.txt with the REAL
       providers and verifies the final MP4 with ffprobe, then opens it.
    7. Writes tmp\windows-run-report.txt (no secrets).

  Compatible with Windows PowerShell 5.1 and PowerShell 7+.
#>
[CmdletBinding()]
param(
  [int]$Duration = 60,
  [string]$Email = "studio@example.com",
  [string]$Script = "examples\sample-story.txt",
  [switch]$SkipInstall,
  [switch]$SkipTests,
  [switch]$NoOpen,
  [switch]$StartApp
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot
New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot "tmp") | Out-Null
$ReportPath = Join-Path $RepoRoot "tmp\windows-run-report.txt"
$Report = New-Object System.Collections.Generic.List[string]
$OnWindows = ($PSVersionTable.PSEdition -eq "Desktop") -or ((Get-Variable -Name IsWindows -ErrorAction SilentlyContinue) -and $IsWindows)

function Write-Step([string]$msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Add-Report([string]$status, [string]$item, [string]$detail) {
  $line = "{0,-8} {1,-38} {2}" -f $status, $item, $detail
  $Report.Add($line)
  $color = switch ($status) { "PASS" { "Green" } "FIXED" { "Yellow" } "BLOCKED" { "Red" } "FAIL" { "Red" } default { "Gray" } }
  Write-Host $line -ForegroundColor $color
}
function Save-Report {
  $header = @("AI Fantasy Studio - Windows run report", ("Generated: {0}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss")), ("Repository: {0}" -f $RepoRoot), "")
  ($header + $Report) | Set-Content -Path $ReportPath -Encoding UTF8
  Write-Host ""
  Write-Host "Report: $ReportPath" -ForegroundColor Cyan
}
function Stop-Blocked([string]$item, [string]$action) {
  Add-Report "BLOCKED" $item $action
  Save-Report
  Write-Host ""
  Write-Host "ACTION NEEDED: $action" -ForegroundColor Red
  Write-Host "Then run this same command again; finished steps are skipped/fast." -ForegroundColor Red
  exit 2
}
function Test-Cmd([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Update-SessionPath {
  if (-not $OnWindows) { return }
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}
function Invoke-Native([string]$exe, [string[]]$arguments, [string]$logName) {
  # Runs a native command, tees output to tmp\<logName>.log, returns exit code.
  $log = Join-Path $RepoRoot "tmp\$logName.log"
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $exe @arguments 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $log | Out-Host
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  return $code
}
function Install-WithWinget([string]$id, [string]$label) {
  if ($SkipInstall) { Stop-Blocked $label "Install $label (winget id $id) - automatic install was disabled with -SkipInstall." }
  if (-not $OnWindows) { Stop-Blocked $label "Install $label manually (automatic install is only implemented for Windows/winget)." }
  if (-not (Test-Cmd "winget")) {
    Stop-Blocked $label "winget is missing. Install 'App Installer' from the Microsoft Store, or install $label manually."
  }
  Write-Host "Installing $label with winget ($id). Approve the Windows UAC prompt if it appears..." -ForegroundColor Yellow
  $code = Invoke-Native "winget" @("install", "--id", $id, "-e", "--source", "winget", "--accept-source-agreements", "--accept-package-agreements") "winget-$id"
  Update-SessionPath
  if ($code -ne 0) {
    Stop-Blocked $label "winget could not install $id (exit $code). If you declined the UAC prompt, run again and approve it. Log: tmp\winget-$id.log"
  }
  Add-Report "FIXED" $label "installed with winget ($id)"
}
function Get-NodeVersion {
  if (-not (Test-Cmd "node")) { return $null }
  $v = (& node -v) -replace "^v", ""
  try { return [version]$v } catch { return $null }
}

# ---------------------------------------------------------------- 1. tools
Write-Step "1/8 Checking required software"

$nodeVer = Get-NodeVersion
if (-not $nodeVer -or $nodeVer -lt [version]"22.9.0") {
  Install-WithWinget "OpenJS.NodeJS.LTS" "Node.js LTS"
  $nodeVer = Get-NodeVersion
  if (-not $nodeVer -or $nodeVer -lt [version]"22.9.0") {
    Stop-Blocked "Node.js" ("Node.js >= 22.9 required, found '{0}'. Close this window, open a new PowerShell and run again." -f $nodeVer)
  }
}
Add-Report "PASS" "Node.js" ("v{0}" -f $nodeVer)
if (-not (Test-Cmd "npm")) { Stop-Blocked "npm" "npm not found next to Node.js. Reinstall Node.js LTS, then open a new PowerShell." }
Add-Report "PASS" "npm" ("v{0}" -f (& npm -v))

if (-not (Test-Cmd "git")) { Install-WithWinget "Git.Git" "Git" }
Add-Report "PASS" "Git" ((& git --version) -join " ")

if (-not (Test-Cmd "ffmpeg") -or -not (Test-Cmd "ffprobe")) {
  Install-WithWinget "Gyan.FFmpeg" "FFmpeg (full build)"
  if (-not (Test-Cmd "ffmpeg")) { Stop-Blocked "FFmpeg" "FFmpeg was installed but is not on PATH yet. Close this window, open a new PowerShell and run again." }
}
$filters = (& ffmpeg -hide_banner -filters 2>&1) -join "`n"
$missing = @("zoompan", "loudnorm", "sidechaincompress", "subtitles", "blackdetect", "freezedetect") | Where-Object { $filters -notmatch "\s$_\s" }
if ($missing) { Stop-Blocked "FFmpeg filters" ("Your FFmpeg build lacks: {0}. Install the full build: winget install --id Gyan.FFmpeg -e" -f ($missing -join ", ")) }
Add-Report "PASS" "FFmpeg" (((& ffmpeg -hide_banner -version) | Select-Object -First 1) -replace "Copyright.*", "")

Add-Report "INFO" "Python" "not required by this project"

if (-not (Test-Cmd "docker")) { Install-WithWinget "Docker.DockerDesktop" "Docker Desktop" }
if (-not (Test-Cmd "docker")) { Stop-Blocked "Docker Desktop" "Docker Desktop was installed. Windows may need a restart (and WSL 2). Restart Windows, start Docker Desktop once, accept its terms, then run again." }

# ---------------------------------------------------------------- 3. .env
Write-Step "2/8 Configuring .env (secrets stay local, never printed)"
$envFile = Join-Path $RepoRoot ".env"
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $RepoRoot ".env.example") $envFile
  Add-Report "FIXED" ".env" "created from .env.example"
}
$envLines = New-Object System.Collections.Generic.List[string]
Get-Content $envFile | ForEach-Object { $envLines.Add($_) }

function Get-EnvValue([string]$name) {
  foreach ($l in $envLines) { if ($l -match ("^{0}=(.*)$" -f [regex]::Escape($name))) { return $Matches[1].Trim() } }
  return ""
}
function Set-EnvValue([string]$name, [string]$value) {
  for ($i = 0; $i -lt $envLines.Count; $i++) {
    if ($envLines[$i] -match ("^{0}=" -f [regex]::Escape($name))) { $envLines[$i] = "$name=$value"; return }
  }
  $envLines.Add("$name=$value")
}
function Get-Masked([string]$v) { if ($v.Length -le 6) { return "******" } return $v.Substring(0, 4) + "..." + "(" + $v.Length + " chars)" }
function ConvertFrom-Secure([Security.SecureString]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

if (-not (Get-EnvValue "SESSION_SECRET")) {
  $bytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  Set-EnvValue "SESSION_SECRET" (([Convert]::ToBase64String($bytes)) -replace "[/+=]", "")
  Add-Report "FIXED" "SESSION_SECRET" "generated"
}

$required = @(
  @{ Name = "ANTHROPIC_API_KEY"; Secret = $true; Where = "https://console.anthropic.com -> API Keys -> Create Key (account needs credit)" },
  @{ Name = "SPEECH_KEY"; Secret = $true; Where = "Azure portal -> your Speech resource -> Keys and Endpoint -> KEY 1" },
  @{ Name = "SPEECH_REGION"; Secret = $false; Where = "Azure portal -> your Speech resource -> Keys and Endpoint -> Location/Region (e.g. eastus)" },
  @{ Name = "CLOUDFLARE_ACCOUNT_ID"; Secret = $false; Where = "https://dash.cloudflare.com -> Account ID (right side of account home)" },
  @{ Name = "CLOUDFLARE_API_TOKEN"; Secret = $true; Where = "https://dash.cloudflare.com/profile/api-tokens -> Create Token with 'Workers AI - Read' + 'Workers AI - Edit'" }
)
$interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
foreach ($r in $required) {
  $name = $r.Name
  $current = Get-EnvValue $name
  $fromEnv = [Environment]::GetEnvironmentVariable($name)
  if (-not $current -and $fromEnv) { Set-EnvValue $name $fromEnv.Trim(); $current = $fromEnv.Trim() }
  if (-not $current -and $interactive) {
    Write-Host ("{0} is not set. Create it here: {1}" -f $name, $r.Where) -ForegroundColor Yellow
    if ($r.Secret) { $v = ConvertFrom-Secure (Read-Host -AsSecureString ("Paste {0} (input hidden, Enter to skip)" -f $name)) }
    else { $v = Read-Host ("Enter {0} (Enter to skip)" -f $name) }
    if ($v) { Set-EnvValue $name $v.Trim(); $current = $v.Trim() }
  }
  if ($current) {
    $shown = $current
    if ($r.Secret) { $shown = Get-Masked $current }
    Add-Report "PASS" $name ("set ({0})" -f $shown)
  }
}
# Video: no key, no payment. Runway stays optional.
if (-not (Get-EnvValue "VIDEO_PROVIDER")) { Set-EnvValue "VIDEO_PROVIDER" "ffmpeg_motion" }
[IO.File]::WriteAllLines($envFile, $envLines.ToArray(), (New-Object System.Text.UTF8Encoding($false)))
$stillMissing = $required | Where-Object { -not (Get-EnvValue $_.Name) }

# ---------------------------------------------------------------- 2. docker
Write-Step "3/8 Starting Docker, Postgres and Redis"
function Test-DockerUp { & docker info *> $null; return ($LASTEXITCODE -eq 0) }
if (-not (Test-DockerUp)) {
  $dd = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
  if ($OnWindows -and (Test-Path $dd)) {
    Write-Host "Starting Docker Desktop (first start can take a few minutes)..." -ForegroundColor Yellow
    Start-Process -FilePath $dd | Out-Null
  }
  $deadline = (Get-Date).AddMinutes(4)
  while (-not (Test-DockerUp) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5 }
  if (-not (Test-DockerUp)) {
    Stop-Blocked "Docker engine" "Docker Desktop is not running. Open Docker Desktop, finish its first-run setup (accept terms; enable WSL 2 if asked - this may need admin approval and a restart) until it says 'Engine running', then run again."
  }
}
Add-Report "PASS" "Docker engine" ((& docker version --format "{{.Server.Version}}") -join "")

$code = Invoke-Native "docker" @("compose", "up", "-d", "postgres", "redis") "docker-compose"
if ($code -ne 0) {
  Stop-Blocked "Postgres/Redis containers" "docker compose failed (see tmp\docker-compose.log). If ports 5432 or 6379 are already used by another Postgres/Redis on this PC, stop that service and run again."
}
$deadline = (Get-Date).AddMinutes(2)
do {
  & docker compose exec -T postgres pg_isready -U studio *> $null
  $ready = ($LASTEXITCODE -eq 0)
  if (-not $ready) { Start-Sleep -Seconds 3 }
} while (-not $ready -and (Get-Date) -lt $deadline)
if (-not $ready) { Stop-Blocked "Postgres" "Postgres container did not become ready. Check: docker compose logs postgres" }
& docker compose exec -T postgres psql -U studio -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='studio_test'" 2>$null | Out-String | ForEach-Object {
  if ($_.Trim() -ne "1") { & docker compose exec -T postgres createdb -U studio studio_test *> $null }
}
Add-Report "PASS" "Postgres + Redis" "containers running (docker compose)"

# ---------------------------------------------------------------- 4. install + db
Write-Step "4/8 Installing dependencies and migrating the database"
if ((Invoke-Native "npm" @("ci") "npm-ci") -ne 0) { Stop-Blocked "npm ci" "npm ci failed - see tmp\npm-ci.log (often a network/proxy problem)." }
Add-Report "PASS" "npm ci" "dependencies installed"
if ((Invoke-Native "npm" @("run", "db:migrate") "db-migrate") -ne 0) { Stop-Blocked "DB migrations" "Migration failed - see tmp\db-migrate.log." }
Add-Report "PASS" "DB migrations" "applied"

# ---------------------------------------------------------------- 5. quality gates
Write-Step "5/8 Lint, typecheck, tests, build"
foreach ($gate in @(@("lint", "Lint"), @("typecheck", "TypeScript"))) {
  if ((Invoke-Native "npm" @("run", $gate[0]) $gate[0]) -ne 0) { Add-Report "FAIL" $gate[1] "see tmp\$($gate[0]).log" } else { Add-Report "PASS" $gate[1] "clean" }
}
if (-not $SkipTests) {
  $code = Invoke-Native "npm" @("test") "npm-test"
  $summary = (Select-String -Path (Join-Path $RepoRoot "tmp\npm-test.log") -Pattern "Tests\s+\d+" | Select-Object -Last 1)
  $detail = "see tmp\npm-test.log"
  if ($summary) { $detail = $summary.Line.Trim() }
  if ($code -ne 0) { Add-Report "FAIL" "Automated tests" $detail } else { Add-Report "PASS" "Automated tests" $detail }
}
if ((Invoke-Native "npm" @("run", "build") "npm-build") -ne 0) { Stop-Blocked "Production build" "next build failed - see tmp\npm-build.log." }
Add-Report "PASS" "Production build" "next build succeeded"

# ---------------------------------------------------------------- 6. providers
Write-Step "6/8 Validating providers against their live APIs"
if ($stillMissing) {
  $names = ($stillMissing | ForEach-Object { $_.Name }) -join ", "
  $hints = ($stillMissing | ForEach-Object { "  {0}: {1}" -f $_.Name, $_.Where }) -join [Environment]::NewLine
  Write-Host $hints -ForegroundColor Yellow
  Stop-Blocked "API keys" ("Missing $names. Set them as environment variables or in .env (see above where to create each), then run again.")
}
$code = Invoke-Native "npm" @("run", "providers:check") "providers-check"
if ($code -ne 0) {
  $fails = Select-String -Path (Join-Path $RepoRoot "tmp\providers-check.log") -Pattern "^\s+\S+\s.*" | Where-Object { $_.Line -match "✕" } | ForEach-Object { $_.Line.Trim() }
  Stop-Blocked "Provider validation" ("A provider rejected the configuration: " + ($fails -join " | ") + ". Fix that key/region (see tmp\providers-check.log) and run again.")
}
Add-Report "PASS" "Providers (live)" "Anthropic, Azure Speech, Cloudflare, ffmpeg_motion validated"

# ---------------------------------------------------------------- 7. real pipeline
Write-Step "7/8 Generating a REAL $Duration-second film (this can take 5-15 minutes)"
$code = Invoke-Native "npm" @("run", "pipeline:run", "--", "--script", $Script, "--duration", "$Duration", "--email", $Email) "pipeline-run"
$log = Get-Content (Join-Path $RepoRoot "tmp\pipeline-run.log")
$finalLine = $log | Where-Object { $_ -match "^Final video: " } | Select-Object -Last 1
$errLine = $log | Where-Object { $_ -match "^Error: " } | Select-Object -Last 1
$pwLine = $log | Where-Object { $_ -match "^Created user " } | Select-Object -Last 1
if ($code -ne 0 -or -not $finalLine) {
  $reason = "see tmp\pipeline-run.log"
  if ($errLine) { $reason = $errLine }
  Add-Report "FAIL" "Pipeline run" $reason
  Save-Report
  Write-Host "The pipeline did not complete: $reason" -ForegroundColor Red
  Write-Host "Re-running resumes from the last completed item: npm run pipeline:run -- --project <id from tmp\pipeline-run.log>" -ForegroundColor Yellow
  exit 1
}
$video = ($finalLine -replace "^Final video: ", "").Trim()
Add-Report "PASS" "Pipeline run" "COMPLETED"

# ---------------------------------------------------------------- 8. verify output
Write-Step "8/8 Verifying the final video file"
if (-not (Test-Path $video)) { Add-Report "FAIL" "Final video" "file not found: $video"; Save-Report; exit 1 }
$probe = & ffprobe -v error -print_format json -show_format -show_streams "$video" | Out-String | ConvertFrom-Json
$v = $probe.streams | Where-Object { $_.codec_type -eq "video" } | Select-Object -First 1
$a = $probe.streams | Where-Object { $_.codec_type -eq "audio" } | Select-Object -First 1
$s = $probe.streams | Where-Object { $_.codec_type -eq "subtitle" } | Select-Object -First 1
$size = (Get-Item $video).Length
$ok = $v -and $a -and $v.codec_name -eq "h264" -and $a.codec_name -eq "aac" -and $size -gt 0
$subInfo = ""
if ($s) {
  $lang = "unknown"
  if (($s.PSObject.Properties.Name -contains "tags") -and ($s.tags.PSObject.Properties.Name -contains "language")) { $lang = $s.tags.language }
  $subInfo = ", subtitles: $lang"
}
$detail = "no video/audio stream found"
if ($v -and $a) { $detail = "{0}x{1} {2}/{3}, {4:N1}s, {5:N1} MB{6}" -f $v.width, $v.height, $v.codec_name, $a.codec_name, [double]$probe.format.duration, ($size / 1MB), $subInfo }
if ($ok) { Add-Report "PASS" "Final video (ffprobe)" $detail } else { Add-Report "FAIL" "Final video (ffprobe)" $detail }
Add-Report "INFO" "Final video path" $video
if ($pwLine) { Add-Report "INFO" "UI login" ($pwLine -replace "^Created user ", "") }
Save-Report

if (-not $NoOpen -and $OnWindows) { Start-Process -FilePath $video }
if ($StartApp) {
  Start-Process -FilePath "powershell" -ArgumentList "-NoExit", "-Command", "Set-Location '$RepoRoot'; npm start"
  Start-Process -FilePath "powershell" -ArgumentList "-NoExit", "-Command", "Set-Location '$RepoRoot'; npm run worker"
  Start-Sleep -Seconds 8
  Start-Process "http://localhost:3000"
}
if (-not $ok) { exit 1 }
Write-Host ""
Write-Host "DONE: real film generated and verified -> $video" -ForegroundColor Green
