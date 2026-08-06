<#
.SYNOPSIS
  Simulates a fingerprint terminal against a running backend.

.DESCRIPTION
  The ADMS protocol a real terminal speaks is plain HTTP, so the whole scan
  path can be exercised before any hardware arrives. This script performs the
  same exchange a ZKTeco terminal would: it handshakes, pushes an attendance
  punch, and then reads the daily register back to prove the scan landed.

  Run it as a file rather than pasting commands into the console — PowerShell's
  backtick line-continuation is easily broken by copy and paste, which turns
  into a confusing "positional parameter cannot be found" error.

.PARAMETER Pin
  The terminal PIN to scan with. Defaults to the first student who has one.
  Pass a PIN no student owns (e.g. 9999) to test the unmatched-scan path.

.PARAMETER Time
  Arrival time as HH:mm in school-local time. Defaults to now.

.PARAMETER Late
  Shorthand for an arrival after the late cut-off, to check the late rule.

.PARAMETER Duplicate
  Send the same punch twice, to prove the terminal's retry is safe to repeat.

.PARAMETER CheckOut
  Send a departure punch for somebody who has already arrived today, timed far
  enough after their arrival to count as a check-out. Without this, running the
  script twice scans two *different* students a few minutes apart, which can
  never produce a check-out.

.EXAMPLE
  .\simulate-terminal.ps1 -Password 'your-admin-password'

.EXAMPLE
  .\simulate-terminal.ps1 -Password 'pw' -Pin 1002 -Late

.EXAMPLE
  .\simulate-terminal.ps1 -Password 'pw' -Pin 9999   # unmatched scan
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://localhost:4000',
  [string]$Email = 'admin@school.local',
  [Parameter(Mandatory = $true)][string]$Password,
  [string]$Serial = 'SIMULATOR1',
  [string]$Pin,
  [string]$Time,
  [switch]$Late,
  [switch]$Duplicate,
  [switch]$CheckOut
)

$ErrorActionPreference = 'Stop'
$BaseUrl = $BaseUrl.TrimEnd('/')

function Write-Step { param([string]$Text) Write-Host "`n$Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  $Text" -ForegroundColor Green }
function Write-Info { param([string]$Text) Write-Host "  $Text" -ForegroundColor Gray }

# --- 1. Sign in -------------------------------------------------------------
Write-Step '1. Signing in'
try {
  $loginBody = @{ email = $Email; password = $Password } | ConvertTo-Json
  $login = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/auth/login" -ContentType 'application/json' -Body $loginBody
} catch {
  Write-Host "  Could not sign in as $Email." -ForegroundColor Red
  Write-Host '  Check the password, and that the backend is running (npm run dev).' -ForegroundColor Red
  exit 1
}
$H = @{ Authorization = "Bearer $($login.accessToken)" }
Write-Ok "signed in as $($login.user.full_name)"

# --- 2. Make sure a terminal is registered ---------------------------------
# The push secret is only shown once at registration, so for an already-known
# serial we rotate it. That keeps the script re-runnable.
Write-Step "2. Preparing terminal $Serial"
$existing = (Invoke-RestMethod -Uri "$BaseUrl/api/devices" -Headers $H) | Where-Object { $_.serial_number -eq $Serial }

if ($null -eq $existing) {
  $deviceBody = @{ serialNumber = $Serial; name = 'Simulated Terminal'; location = 'Test bench' } | ConvertTo-Json
  $device = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/devices" -Headers $H -ContentType 'application/json' -Body $deviceBody
  $Secret = $device.pushSecret
  Write-Ok 'registered a new terminal'
} else {
  $rotated = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/devices/$($existing.id)/rotate-secret" -Headers $H -ContentType 'application/json' -Body '{}'
  $Secret = $rotated.pushSecret
  Write-Ok 'reusing the existing terminal (push secret rotated)'
}

# --- 3. Choose a PIN --------------------------------------------------------
Write-Step '3. Choosing a student'
$registerBefore = (Invoke-RestMethod -Uri "$BaseUrl/api/attendance/register" -Headers $H).rows

if ([string]::IsNullOrWhiteSpace($Pin)) {
  if ($CheckOut) {
    # A departure needs somebody who has already arrived and not yet left.
    $candidate = $registerBefore | Where-Object { $_.device_user_pin -and $_.check_in_at -and -not $_.check_out_at } | Select-Object -First 1
    if ($null -eq $candidate) {
      Write-Host '  Nobody has checked in today, so there is no departure to record.' -ForegroundColor Red
      Write-Host '  Run the script without -CheckOut first to send an arrival.' -ForegroundColor Red
      exit 1
    }
  } else {
    # Prefer somebody who has not scanned yet today. The register keeps the
    # *earliest* punch of the day as the check-in, so sending a punch for a
    # student who already arrived would change nothing visible and make the
    # result look wrong.
    $candidate = $registerBefore | Where-Object { $_.device_user_pin -and $_.status -eq 'not_marked' } | Select-Object -First 1
    if ($null -eq $candidate) {
      $candidate = $registerBefore | Where-Object { $_.device_user_pin } | Select-Object -First 1
    }
  }
  if ($null -eq $candidate) {
    Write-Host '  No student has a terminal PIN yet.' -ForegroundColor Red
    Write-Host '  Add one under Students, or pass -Pin 9999 to test an unmatched scan.' -ForegroundColor Red
    exit 1
  }
  $Pin = $candidate.device_user_pin
  Write-Ok "using $($candidate.full_name) (PIN $Pin, currently $($candidate.status))"
} else {
  $existingRow = $registerBefore | Where-Object { $_.device_user_pin -eq $Pin }
  Write-Ok "using PIN $Pin as supplied"
  if ($null -ne $existingRow -and $existingRow.status -ne 'not_marked') {
    Write-Host "  Note: this student is already $($existingRow.status) today." -ForegroundColor Yellow
    Write-Host '  The register keeps the earliest arrival, so a later punch will not change it.' -ForegroundColor Yellow
  }
}

# --- 4. Handshake -----------------------------------------------------------
# A real terminal does this on boot to collect its polling configuration.
Write-Step '4. Handshake'
$handshake = Invoke-RestMethod -Uri "$BaseUrl/iclock/cdata?SN=$Serial&options=all&pushver=2.4.1&key=$Secret"
$firstLine = ($handshake -split "`r?`n")[0]
Write-Ok $firstLine

# --- 5. Push the punch ------------------------------------------------------
$today = (Get-Date).ToString('yyyy-MM-dd')

if ($CheckOut) {
  # A later punch only counts as leaving once the student has been in school
  # for minimum_checkout_gap_minutes. Read that from settings rather than
  # assuming, and clear it by a few minutes.
  $settings = Invoke-RestMethod -Uri "$BaseUrl/api/settings" -Headers $H
  $gap = [int]$settings.minimum_checkout_gap_minutes

  $todayPunches = Invoke-RestMethod -Uri "$BaseUrl/api/attendance/events?limit=200&date=$today" -Headers $H
  $arrival = ($todayPunches | Where-Object { $_.device_user_pin -eq $Pin } | Sort-Object local_time | Select-Object -First 1).local_time
  if ($null -eq $arrival) {
    Write-Host "  PIN $Pin has not arrived today, so there is no departure to record." -ForegroundColor Red
    exit 1
  }

  $departure = [datetime]::ParseExact($arrival, 'HH:mm:ss', $null).AddMinutes($gap + 5)
  if ($departure.Day -ne [datetime]::ParseExact($arrival, 'HH:mm:ss', $null).Day) {
    Write-Host "  Arrival was at $arrival; adding $gap minutes runs past midnight." -ForegroundColor Red
    Write-Host '  Send an earlier arrival first, e.g. -Time 07:05.' -ForegroundColor Red
    exit 1
  }
  $clock = $departure.ToString('HH:mm:ss')
  Write-Info "arrived $arrival, check-out gap is $gap min, so departing at $clock"
} elseif ($Late) {
  $clock = '08:30:00'
} elseif ($Time) {
  $clock = "$Time`:00"
} else {
  $clock = (Get-Date).ToString('HH:mm:ss')
}
$stamp = "$today $clock"

# Tab separated: PIN, timestamp, punch state, verify mode.
$scan = "$Pin`t$stamp`t0`t1`n"

Write-Step "5. Sending a $(if ($CheckOut) { 'departure' } else { 'scan' }) at $stamp"
$response = Invoke-RestMethod -Method Post -ContentType 'text/plain' -Body $scan -Uri "$BaseUrl/iclock/cdata?SN=$Serial&table=ATTLOG&key=$Secret"
Write-Ok "terminal received: $($response.ToString().Trim())"

if ($Duplicate) {
  $again = Invoke-RestMethod -Method Post -ContentType 'text/plain' -Body $scan -Uri "$BaseUrl/iclock/cdata?SN=$Serial&table=ATTLOG&key=$Secret"
  Write-Ok "re-sent the same punch: $($again.ToString().Trim())  (should not create a second record)"
}

# --- 6. Read it back --------------------------------------------------------
Write-Step '6. Checking the result'
Start-Sleep -Milliseconds 500

# The events feed reports local_time as a plain school-local string, which
# avoids any timezone guesswork when printing it back here.
$events = Invoke-RestMethod -Uri "$BaseUrl/api/attendance/events?limit=100&date=$today" -Headers $H
$mine = $events | Where-Object { $_.device_user_pin -eq $Pin } | Select-Object -First 1
if ($null -ne $mine) {
  Write-Ok "punch stored at $($mine.local_time) school time on $($mine.local_date)"
}

$register = Invoke-RestMethod -Uri "$BaseUrl/api/attendance/register" -Headers $H
$row = $register.rows | Where-Object { $_.device_user_pin -eq $Pin }

if ($null -eq $row) {
  $unmatched = Invoke-RestMethod -Uri "$BaseUrl/api/attendance/unmatched" -Headers $H
  $hit = $unmatched | Where-Object { $_.device_user_pin -eq $Pin }
  if ($null -ne $hit) {
    Write-Host "  PIN $Pin matches no student, so the scan was recorded as unmatched ($($hit.scan_count) scan(s))." -ForegroundColor Yellow
    Write-Host '  That is the expected behaviour — see Terminals > Unmatched scans.' -ForegroundColor Yellow
  } else {
    Write-Host "  Nothing found for PIN $Pin. Check the backend log for the reason." -ForegroundColor Red
    exit 1
  }
} else {
  Write-Ok "$($row.full_name) is marked $($row.status)"
  Write-Info "class: $($row.class_name)"
  if ($row.check_out_at) {
    Write-Ok 'check-out recorded'
  } elseif ($CheckOut) {
    Write-Host '  No check-out recorded — the punch was not far enough after the arrival.' -ForegroundColor Yellow
  }
  if ($row.minutes_late -gt 0) { Write-Info "late by $($row.minutes_late) minutes" }
  if ($row.status -eq 'present' -and $Late) {
    Write-Host '  Expected late but got present — this student had an earlier punch today,' -ForegroundColor Yellow
    Write-Host '  and the earliest arrival is the one that counts. Try a student who has' -ForegroundColor Yellow
    Write-Host '  not scanned yet, or run against a date with no prior scans.' -ForegroundColor Yellow
  }
}

Write-Host "`nDone. The dashboard should show this too." -ForegroundColor Cyan
