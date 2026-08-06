#!/usr/bin/env bash
#
# Simulates a fingerprint terminal against a running backend.
#
# The ADMS protocol a real terminal speaks is plain HTTP, so the whole scan path
# can be exercised before any hardware arrives. This performs the same exchange
# a ZKTeco terminal would: handshake, push a punch, then read the register back
# to prove it landed.
#
# Usage:
#   ./simulate-terminal.sh -p 'admin-password'
#   ./simulate-terminal.sh -p 'pw' -n 1002 -l          # a late arrival
#   ./simulate-terminal.sh -p 'pw' -n 9999             # an unmatched scan
#   ./simulate-terminal.sh -p 'pw' -t 07:15 -d         # a specific time, sent twice
#   ./simulate-terminal.sh -p 'pw' -o                  # a departure, for check-out
#
# The PowerShell equivalent is simulate-terminal.ps1.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000}"
EMAIL="admin@school.local"
PASSWORD=""
SERIAL="SIMULATOR1"
PIN=""
TIME=""
LATE=0
DUPLICATE=0
CHECKOUT=0

usage() {
  sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while getopts "u:e:p:s:n:t:ldoh" opt; do
  case "$opt" in
    u) BASE_URL="$OPTARG" ;;
    e) EMAIL="$OPTARG" ;;
    p) PASSWORD="$OPTARG" ;;
    s) SERIAL="$OPTARG" ;;
    n) PIN="$OPTARG" ;;
    t) TIME="$OPTARG" ;;
    l) LATE=1 ;;
    d) DUPLICATE=1 ;;
    o) CHECKOUT=1 ;;
    h) usage 0 ;;
    *) usage 1 ;;
  esac
done

[ -n "$PASSWORD" ] || { echo "error: -p <password> is required" >&2; usage 1; }
BASE_URL="${BASE_URL%/}"

command -v python3 >/dev/null || { echo "error: python3 is required for JSON parsing" >&2; exit 1; }

jqp() { python3 -c "import sys,json$1"; }

cyan()  { printf '\n\033[36m%s\033[0m\n' "$1"; }
green() { printf '  \033[32m%s\033[0m\n' "$1"; }
grey()  { printf '  \033[90m%s\033[0m\n' "$1"; }
amber() { printf '  \033[33m%s\033[0m\n' "$1"; }
red()   { printf '  \033[31m%s\033[0m\n' "$1"; }

# --- 1. Sign in --------------------------------------------------------------
cyan "1. Signing in"
LOGIN=$(curl -s -X POST "$BASE_URL/api/auth/login" -H 'Content-Type: application/json' \
  -d "$(python3 -c "import json,sys;print(json.dumps({'email':sys.argv[1],'password':sys.argv[2]}))" "$EMAIL" "$PASSWORD")")
TOKEN=$(echo "$LOGIN" | jqp ";d=json.load(sys.stdin);print(d.get('accessToken',''))")
if [ -z "$TOKEN" ]; then
  red "Could not sign in as $EMAIL."
  red "Check the password, and that the backend is running (npm run dev)."
  exit 1
fi
AUTH="Authorization: Bearer $TOKEN"
green "signed in as $(echo "$LOGIN" | jqp ";print(json.load(sys.stdin)['user']['full_name'])")"

# --- 2. Make sure a terminal is registered -----------------------------------
# The push secret is only shown once at registration, so an already-known serial
# gets its secret rotated. That keeps this script re-runnable.
cyan "2. Preparing terminal $SERIAL"
DEVICE_ID=$(curl -s "$BASE_URL/api/devices" -H "$AUTH" \
  | jqp ";print(next((str(d['id']) for d in json.load(sys.stdin) if d['serial_number']=='$SERIAL'), ''))")

if [ -z "$DEVICE_ID" ]; then
  SECRET=$(curl -s -X POST "$BASE_URL/api/devices" -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"serialNumber\":\"$SERIAL\",\"name\":\"Simulated Terminal\",\"location\":\"Test bench\"}" \
    | jqp ";print(json.load(sys.stdin).get('pushSecret',''))")
  green "registered a new terminal"
else
  SECRET=$(curl -s -X POST "$BASE_URL/api/devices/$DEVICE_ID/rotate-secret" -H "$AUTH" \
    -H 'Content-Type: application/json' -d '{}' | jqp ";print(json.load(sys.stdin).get('pushSecret',''))")
  green "reusing the existing terminal (push secret rotated)"
fi

# --- 3. Choose a PIN ---------------------------------------------------------
cyan "3. Choosing a student"
REGISTER=$(curl -s "$BASE_URL/api/attendance/register" -H "$AUTH")

if [ -z "$PIN" ]; then
  # Prefer somebody who has not scanned yet. The register keeps the *earliest*
  # punch of the day, so a punch for a student who already arrived changes
  # nothing visible and makes the result look wrong.
  read -r PIN PICKED <<<"$(echo "$REGISTER" | CHECKOUT="$CHECKOUT" jqp ",os
d=json.load(sys.stdin)['rows']
if os.environ['CHECKOUT']=='1':
    # A departure needs somebody who has already arrived and not yet left.
    c=next((r for r in d if r['device_user_pin'] and r['check_in_at'] and not r['check_out_at']), None)
else:
    c=next((r for r in d if r['device_user_pin'] and r['status']=='not_marked'), None) \
      or next((r for r in d if r['device_user_pin']), None)
print(f\"{c['device_user_pin']} {c['full_name']}\" if c else ' ')")"
  if [ -z "$PIN" ]; then
    if [ "$CHECKOUT" -eq 1 ]; then
      red "Nobody has checked in today, so there is no departure to record."
      red "Run without -o first to send an arrival."
    else
      red "No student has a terminal PIN yet."
      red "Add one under Students, or pass -n 9999 to test an unmatched scan."
    fi
    exit 1
  fi
  green "using $PICKED (PIN $PIN)"
else
  green "using PIN $PIN as supplied"
  STATUS=$(echo "$REGISTER" | jqp ";
d=json.load(sys.stdin)['rows']
r=next((x for x in d if x['device_user_pin']=='$PIN'), None)
print(r['status'] if r else '')")
  if [ -n "$STATUS" ] && [ "$STATUS" != "not_marked" ]; then
    amber "Note: this student is already $STATUS today."
    amber "The register keeps the earliest arrival, so a later punch will not change it."
  fi
fi

# --- 4. Handshake ------------------------------------------------------------
cyan "4. Handshake"
green "$(curl -s "$BASE_URL/iclock/cdata?SN=$SERIAL&options=all&pushver=2.4.1&key=$SECRET" | head -1)"

# --- 5. Push the punch -------------------------------------------------------
TODAY="$(date +%Y-%m-%d)"

if [ "$CHECKOUT" -eq 1 ]; then
  # A later punch only counts as leaving once the student has been in school
  # for minimum_checkout_gap_minutes. Read that rather than assuming it, and
  # clear it by a few minutes. Scoped to today, or an earlier local time from a
  # previous day would be mistaken for this morning's arrival.
  GAP=$(curl -s "$BASE_URL/api/settings" -H "$AUTH" | jqp ";print(json.load(sys.stdin)['minimum_checkout_gap_minutes'])")
  ARRIVAL=$(curl -s "$BASE_URL/api/attendance/events?limit=200&date=$TODAY" -H "$AUTH" | jqp ";
e=[x for x in json.load(sys.stdin) if x['device_user_pin']=='$PIN']
print(min(x['local_time'] for x in e) if e else '')")
  if [ -z "$ARRIVAL" ]; then
    red "PIN $PIN has not arrived today, so there is no departure to record."
    exit 1
  fi
  CLOCK=$(date -d "$ARRIVAL today + $((GAP + 5)) minutes" +%H:%M:%S)
  if [ "$(date -d "$ARRIVAL today + $((GAP + 5)) minutes" +%Y-%m-%d)" != "$TODAY" ]; then
    red "Arrival was at $ARRIVAL; adding $GAP minutes runs past midnight."
    red "Send an earlier arrival first, e.g. -t 07:05."
    exit 1
  fi
  grey "arrived $ARRIVAL, check-out gap is $GAP min, so departing at $CLOCK"
elif [ "$LATE" -eq 1 ]; then CLOCK="08:30:00"
elif [ -n "$TIME" ]; then CLOCK="$TIME:00"
else CLOCK="$(date +%H:%M:%S)"; fi
STAMP="$TODAY $CLOCK"

LABEL=$([ "$CHECKOUT" -eq 1 ] && echo departure || echo scan)
cyan "5. Sending a $LABEL at $STAMP"
send_punch() {
  printf '%s\t%s\t0\t1\n' "$PIN" "$STAMP" \
    | curl -s --data-binary @- -H 'Content-Type: text/plain' \
      "$BASE_URL/iclock/cdata?SN=$SERIAL&table=ATTLOG&key=$SECRET"
}
green "terminal received: $(send_punch | tr -d '\r\n')"
if [ "$DUPLICATE" -eq 1 ]; then
  green "re-sent the same punch: $(send_punch | tr -d '\r\n')  (should not create a second record)"
fi

# --- 6. Read it back ---------------------------------------------------------
cyan "6. Checking the result"
sleep 1

# local_time is a plain school-local string, so printing it needs no timezone
# guesswork here.
curl -s "$BASE_URL/api/attendance/events?limit=100&date=$TODAY" -H "$AUTH" | jqp ";
e=next((x for x in json.load(sys.stdin) if x['device_user_pin']=='$PIN'), None)
print(f\"  \033[32mpunch stored at {e['local_time']} school time on {e['local_date']}\033[0m\" if e else '', end='\n' if e else '')"

ROW=$(curl -s "$BASE_URL/api/attendance/register" -H "$AUTH" | jqp ";
d=json.load(sys.stdin)['rows']
r=next((x for x in d if x['device_user_pin']=='$PIN'), None)
print(json.dumps(r) if r else '')")

if [ -z "$ROW" ]; then
  HITS=$(curl -s "$BASE_URL/api/attendance/unmatched" -H "$AUTH" | jqp ";
h=next((x for x in json.load(sys.stdin) if x['device_user_pin']=='$PIN'), None)
print(h['scan_count'] if h else '')")
  if [ -n "$HITS" ]; then
    amber "PIN $PIN matches no student, so the scan was recorded as unmatched ($HITS scan(s))."
    amber "That is the expected behaviour — see Terminals > Unmatched scans."
  else
    red "Nothing found for PIN $PIN. Check the backend log for the reason."
    exit 1
  fi
else
  green "$(echo "$ROW" | jqp ";r=json.load(sys.stdin);print(f\"{r['full_name']} is marked {r['status']}\")")"
  grey "$(echo "$ROW" | jqp ";r=json.load(sys.stdin);print(f\"class: {r['class_name']}\")")"
  MINS=$(echo "$ROW" | jqp ";print(json.load(sys.stdin).get('minutes_late') or 0)")
  [ "$MINS" -gt 0 ] && grey "late by $MINS minutes"
  if echo "$ROW" | grep -q '"check_out_at": *"'; then
    green "check-out recorded"
  elif [ "$CHECKOUT" -eq 1 ]; then
    amber "No check-out recorded — the punch was not far enough after the arrival."
  fi
fi

cyan "Done. The dashboard should show this too."
