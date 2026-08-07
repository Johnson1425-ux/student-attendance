<#
.SYNOPSIS
  Nightly backup of the attendance database to this machine.

.DESCRIPTION
  Takes a compressed pg_dump, verifies it can be read back, prunes old copies
  and appends to a log. Designed to be driven by Task Scheduler.

  It connects *out* to the database, so it works the same whether that database
  is on Neon, on Render, or on this machine. Nothing needs to reach in.

  Put -Folder inside a synced folder (OneDrive, Google Drive, Dropbox). A backup
  that only exists on the machine it is protecting is not a backup — one stolen
  laptop takes both copies. A year of dumps is 10-15 MB, so this costs nothing.

.PARAMETER ConnectionString
  Postgres URL. Defaults to DATABASE_URL from backend/.env, so there is one
  place to configure and it cannot drift out of step with the application.

.PARAMETER Folder
  Where dumps are written. Created if missing.

.PARAMETER KeepDays
  Dumps older than this are deleted. Default 30.

.EXAMPLE
  .\backup-database.ps1

.EXAMPLE
  .\backup-database.ps1 -Folder 'D:\OneDrive\AttendanceBackups' -KeepDays 60
#>
[CmdletBinding()]
param(
  [string]$ConnectionString,
  [string]$Folder = "$env:USERPROFILE\AttendanceBackups",
  [int]$KeepDays = 30
)

$ErrorActionPreference = 'Stop'

function Write-Log {
  param([string]$Message, [string]$Colour = 'Gray')
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line -ForegroundColor $Colour
  if ($script:LogFile) { Add-Content -Path $script:LogFile -Value $line }
}

function Fail {
  param([string]$Message)
  Write-Log "FAILED: $Message" 'Red'
  exit 1
}

# --- Resolve the connection ------------------------------------------------
if (-not $ConnectionString) {
  $envFile = Join-Path $PSScriptRoot '..\backend\.env'
  if (Test-Path $envFile) {
    $match = Select-String -Path $envFile -Pattern '^\s*DATABASE_URL\s*=\s*(.+?)\s*$' | Select-Object -First 1
    if ($match) { $ConnectionString = $match.Matches[0].Groups[1].Value.Trim('"').Trim("'") }
  }
}
if (-not $ConnectionString) {
  Fail 'No connection string. Pass -ConnectionString, or set DATABASE_URL in backend\.env'
}

try {
  $uri = [System.Uri]$ConnectionString
  $dbUser = [System.Uri]::UnescapeDataString($uri.UserInfo.Split(':')[0])
  # Percent-decoded, because a password with @ or / has to be encoded in a URL.
  $dbPass = [System.Uri]::UnescapeDataString($uri.UserInfo.Split(':')[1])
  $dbHost = $uri.Host
  $dbPort = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
  $dbName = $uri.AbsolutePath.TrimStart('/')
} catch {
  Fail "Could not read the connection string. Expected postgres://user:password@host:port/database"
}

# --- Prepare the folder and log --------------------------------------------
New-Item -ItemType Directory -Force -Path $Folder | Out-Null
$script:LogFile = Join-Path $Folder 'backup.log'

Write-Log "Backing up $dbName on $dbHost" 'Cyan'

# --- Check the tools are present and new enough ----------------------------
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $pgDump) {
  Fail 'pg_dump is not on PATH. Add the PostgreSQL bin folder, e.g. C:\Program Files\PostgreSQL\16\bin'
}

$env:PGPASSWORD = $dbPass
try {
  # pg_dump refuses to dump a server newer than itself, which is easy to hit
  # against a managed database that upgraded underneath you. Say so plainly
  # rather than letting the dump fail with a cryptic message at 2am.
  $clientMajor = ([regex]'(\d+)').Match((& pg_dump --version)).Groups[1].Value
  $psql = Get-Command psql -ErrorAction SilentlyContinue
  if ($psql) {
    $serverVersion = (& psql -h $dbHost -p $dbPort -U $dbUser -d $dbName -tAc 'SHOW server_version' 2>$null)
    if ($LASTEXITCODE -eq 0 -and $serverVersion) {
      $serverMajor = ([regex]'(\d+)').Match($serverVersion).Groups[1].Value
      if ([int]$clientMajor -lt [int]$serverMajor) {
        Fail "pg_dump is version $clientMajor but the server is $serverMajor. Install PostgreSQL $serverMajor client tools."
      }
      Write-Log "pg_dump $clientMajor against server $($serverVersion.Trim())"
    }
  }

  # --- Dump --------------------------------------------------------------
  $stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
  $target = Join-Path $Folder "attendance-$stamp.dump"

  & pg_dump --host=$dbHost --port=$dbPort --username=$dbUser --dbname=$dbName `
            --format=custom --compress=9 --file=$target
  if ($LASTEXITCODE -ne 0) { Fail "pg_dump exited with code $LASTEXITCODE" }

  # --- Verify it can actually be read back -------------------------------
  # A dump that was truncated by a full disk or a dropped connection looks
  # fine on the filesystem. Reading the table of contents costs nothing and
  # catches that now rather than on the day you need it.
  & pg_restore --list $target > $null 2>&1
  if ($LASTEXITCODE -ne 0) {
    Remove-Item $target -Force -ErrorAction SilentlyContinue
    Fail 'The dump could not be read back and has been deleted. Check disk space and connectivity.'
  }

  $size = '{0:N1} MB' -f ((Get-Item $target).Length / 1MB)
  Write-Log "Wrote $(Split-Path $target -Leaf) ($size), verified readable" 'Green'
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

# --- Prune ------------------------------------------------------------------
$cutoff = (Get-Date).AddDays(-$KeepDays)
$stale = Get-ChildItem $Folder -Filter 'attendance-*.dump' | Where-Object { $_.LastWriteTime -lt $cutoff }
foreach ($file in $stale) {
  Remove-Item $file.FullName -Force
  Write-Log "Pruned $($file.Name) (older than $KeepDays days)"
}

$kept = @(Get-ChildItem $Folder -Filter 'attendance-*.dump').Count
Write-Log "Done. $kept backup(s) in $Folder" 'Cyan'
