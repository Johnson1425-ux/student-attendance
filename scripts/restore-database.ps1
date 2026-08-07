<#
.SYNOPSIS
  Restores an attendance database from a backup taken by backup-database.ps1.

.DESCRIPTION
  Destructive: everything currently in the target database is replaced. Kept in
  its own script rather than as a flag on the backup, so it cannot be reached by
  accident.

  Restoring is also how you find out whether your backups are any good. Do it
  once into a scratch database before you ever need it for real — a backup
  nobody has restored is a hope, not a plan.

.PARAMETER File
  The .dump file. Defaults to the newest in -Folder.

.PARAMETER ConnectionString
  Where to restore *to*. Defaults to DATABASE_URL from backend/.env.
  Point this at a scratch database when you are only testing.

.PARAMETER Force
  Skip the confirmation prompt. For unattended use only.

.EXAMPLE
  # Rehearsal: restore the newest backup into a scratch database
  .\restore-database.ps1 -ConnectionString 'postgres://user:pw@localhost:5432/attendance_check'

.EXAMPLE
  # The real thing
  .\restore-database.ps1 -File 'D:\AttendanceBackups\attendance-2026-08-06-2100.dump'
#>
[CmdletBinding()]
param(
  [string]$File,
  [string]$Folder = "$env:USERPROFILE\AttendanceBackups",
  [string]$ConnectionString,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Fail { param([string]$m) Write-Host "  $m" -ForegroundColor Red; exit 1 }
function Say  { param([string]$m, [string]$c = 'Gray') Write-Host "  $m" -ForegroundColor $c }

# --- Pick the backup --------------------------------------------------------
if (-not $File) {
  $newest = Get-ChildItem $Folder -Filter 'attendance-*.dump' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $newest) { Fail "No backups found in $Folder. Pass -File explicitly." }
  $File = $newest.FullName
}
if (-not (Test-Path $File)) { Fail "No such file: $File" }

$age = [math]::Round(((Get-Date) - (Get-Item $File).LastWriteTime).TotalHours, 1)
Say "Backup:  $(Split-Path $File -Leaf)  ($age hours old)" 'Cyan'

# --- Resolve the target -----------------------------------------------------
if (-not $ConnectionString) {
  $envFile = Join-Path $PSScriptRoot '..\backend\.env'
  if (Test-Path $envFile) {
    $match = Select-String -Path $envFile -Pattern '^\s*DATABASE_URL\s*=\s*(.+?)\s*$' | Select-Object -First 1
    if ($match) { $ConnectionString = $match.Matches[0].Groups[1].Value.Trim('"').Trim("'") }
  }
}
if (-not $ConnectionString) { Fail 'No target database. Pass -ConnectionString or set DATABASE_URL in backend\.env' }

$uri = [System.Uri]$ConnectionString
$dbUser = [System.Uri]::UnescapeDataString($uri.UserInfo.Split(':')[0])
$dbPass = [System.Uri]::UnescapeDataString($uri.UserInfo.Split(':')[1])
$dbHost = $uri.Host
$dbPort = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
$dbName = $uri.AbsolutePath.TrimStart('/')

Say "Target:  $dbName on $dbHost" 'Cyan'

if (-not $Force) {
  Write-Host ''
  Write-Host "  This REPLACES everything in '$dbName' on $dbHost." -ForegroundColor Yellow
  $answer = Read-Host "  Type the database name to confirm"
  if ($answer -ne $dbName) { Fail 'Cancelled.' }
}

# --- Restore ----------------------------------------------------------------
$env:PGPASSWORD = $dbPass
try {
  # --clean --if-exists drops the old objects first, so this works into a
  # database that already has data. --no-owner lets a dump taken as one role
  # restore under another, which it will be when moving between hosts.
  & pg_restore --host=$dbHost --port=$dbPort --username=$dbUser --dbname=$dbName `
               --clean --if-exists --no-owner --no-privileges $File 2>&1 |
    Where-Object { $_ -notmatch 'does not exist, skipping' } |
    ForEach-Object { Say $_ }

  if ($LASTEXITCODE -ne 0) {
    Say "pg_restore exited with code $LASTEXITCODE — check the messages above." 'Yellow'
    Say 'Some errors are harmless (dropping objects that were not there).' 'Yellow'
  }

  # --- Say what came back ---------------------------------------------------
  $counts = & psql --host=$dbHost --port=$dbPort --username=$dbUser --dbname=$dbName -tAc @'
SELECT 'students=' || (SELECT count(*) FROM students)
    || '  attendance_records=' || (SELECT count(*) FROM attendance_records)
    || '  attendance_events=' || (SELECT count(*) FROM attendance_events)
    || '  staff_accounts=' || (SELECT count(*) FROM users)
'@
  Write-Host ''
  Say "Restored: $($counts.Trim())" 'Green'
  Say 'Compare those against what you expect before trusting it.' 'Gray'
  Write-Host ''
  Say 'Attendance missing since the backup can be recovered from the terminal:' 'Cyan'
  Say 'Terminals > Send command > "Re-request attendance logs" for the date range.' 'Cyan'
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
