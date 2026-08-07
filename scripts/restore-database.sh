#!/usr/bin/env bash
#
# Restores an attendance database from a backup taken by backup-database.sh.
#
# Destructive: everything currently in the target database is replaced. Kept in
# its own script rather than as a flag on the backup, so it cannot be reached by
# accident.
#
# Restoring is also how you find out whether your backups are any good. Do it
# once into a scratch database before you ever need it for real — a backup
# nobody has restored is a hope, not a plan.
#
# Usage:
#   # Rehearsal: newest backup into a scratch database
#   ./restore-database.sh -c 'postgres://user:pw@localhost:5432/attendance_check'
#
#   # The real thing, from a specific file
#   ./restore-database.sh -F ~/AttendanceBackups/attendance-2026-08-06-2100.dump
#
#   -y   skip the confirmation prompt (unattended use only)
#
# The PowerShell equivalent is restore-database.ps1.

set -euo pipefail

FOLDER="${HOME}/AttendanceBackups"
FILE=""
CONNECTION=""
ASSUME_YES=0

usage() { sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while getopts "F:f:c:yh" opt; do
  case "$opt" in
    F) FILE="$OPTARG" ;;
    f) FOLDER="$OPTARG" ;;
    c) CONNECTION="$OPTARG" ;;
    y) ASSUME_YES=1 ;;
    h) usage 0 ;;
    *) usage 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
say()  { printf '  %s\n' "$1"; }
fail() { printf '  \033[31m%s\033[0m\n' "$1"; exit 1; }

# --- Pick the backup ---------------------------------------------------------
if [ -z "$FILE" ]; then
  FILE=$(find "$FOLDER" -maxdepth 1 -name 'attendance-*.dump' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)
  [ -n "$FILE" ] || fail "No backups found in $FOLDER. Pass -F explicitly."
fi
[ -f "$FILE" ] || fail "No such file: $FILE"

AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$FILE") ) / 3600 ))
say "Backup:  $(basename "$FILE")  ($AGE_H hours old)"

# --- Resolve the target ------------------------------------------------------
if [ -z "$CONNECTION" ]; then
  ENV_FILE="$SCRIPT_DIR/../backend/.env"
  if [ -f "$ENV_FILE" ]; then
    CONNECTION=$(sed -n 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" \
      | head -1 | tr -d '"'"'" | tr -d '\r')
  fi
fi
[ -n "$CONNECTION" ] || fail 'No target database. Pass -c or set DATABASE_URL in backend/.env'

eval "$(python3 - "$CONNECTION" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1])
print(f"DB_HOST={u.quote(p.hostname or '')}")
print(f"DB_PORT={p.port or 5432}")
print(f"DB_USER='{u.unquote(p.username or '')}'")
print(f"DB_PASS='{u.unquote(p.password or '')}'")
print(f"DB_NAME='{p.path.lstrip('/')}'")
PY
)"
[ -n "${DB_HOST:-}" ] || fail 'Could not read the connection string.'

say "Target:  $DB_NAME on $DB_HOST"

if [ "$ASSUME_YES" -ne 1 ]; then
  printf '\n  \033[33mThis REPLACES everything in "%s" on %s.\033[0m\n' "$DB_NAME" "$DB_HOST"
  read -r -p "  Type the database name to confirm: " answer
  [ "$answer" = "$DB_NAME" ] || fail 'Cancelled.'
fi

export PGPASSWORD="$DB_PASS"
trap 'unset PGPASSWORD' EXIT

# --clean --if-exists drops the old objects first, so this works into a database
# that already has data. --no-owner lets a dump taken as one role restore under
# another, which it will be when moving between hosts.
pg_restore --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
           --clean --if-exists --no-owner --no-privileges "$FILE" 2>&1 \
  | grep -v 'does not exist, skipping' | sed 's/^/  /' || true

COUNTS=$(psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" -tAc "
SELECT 'students=' || (SELECT count(*) FROM students)
    || '  attendance_records=' || (SELECT count(*) FROM attendance_records)
    || '  attendance_events=' || (SELECT count(*) FROM attendance_events)
    || '  staff_accounts=' || (SELECT count(*) FROM users)")

printf '\n  \033[32mRestored: %s\033[0m\n' "$(echo "$COUNTS" | tr -d '\n')"
say 'Compare those against what you expect before trusting it.'
printf '\n  \033[36m%s\033[0m\n' 'Attendance missing since the backup can be recovered from the terminal:'
printf '  \033[36m%s\033[0m\n' 'Terminals > Send command > "Re-request attendance logs" for the date range.'
