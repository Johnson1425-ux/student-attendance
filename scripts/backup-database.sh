#!/usr/bin/env bash
#
# Nightly backup of the attendance database to this machine.
#
# Takes a compressed pg_dump, verifies it can be read back, prunes old copies
# and appends to a log. Designed to be driven by cron.
#
# It connects *out* to the database, so it works the same whether that database
# is on Neon, on Render, or on this machine. Nothing needs to reach in.
#
# Point -f at a synced folder (Dropbox, Drive, Nextcloud). A backup that only
# exists on the machine it is protecting is not a backup. A year of dumps is
# 10-15 MB, so a second copy costs nothing.
#
# Usage:
#   ./backup-database.sh                          # reads backend/.env
#   ./backup-database.sh -f ~/Dropbox/backups -k 60
#   ./backup-database.sh -c 'postgres://user:pw@host/db'
#
# Suggested crontab entry — 21:00 daily, with output kept for inspection:
#   0 21 * * *  /path/to/scripts/backup-database.sh >> /var/log/attendance-backup.log 2>&1
#
# The PowerShell equivalent is backup-database.ps1.

set -euo pipefail

FOLDER="${HOME}/AttendanceBackups"
KEEP_DAYS=30
CONNECTION=""

usage() { sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while getopts "c:f:k:h" opt; do
  case "$opt" in
    c) CONNECTION="$OPTARG" ;;
    f) FOLDER="$OPTARG" ;;
    k) KEEP_DAYS="$OPTARG" ;;
    h) usage 0 ;;
    *) usage 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$FOLDER"
LOG="$FOLDER/backup.log"

log()  { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" | tee -a "$LOG"; }
fail() { log "FAILED: $1"; exit 1; }

# --- Resolve the connection --------------------------------------------------
if [ -z "$CONNECTION" ]; then
  ENV_FILE="$SCRIPT_DIR/../backend/.env"
  if [ -f "$ENV_FILE" ]; then
    CONNECTION=$(sed -n 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" \
      | head -1 | tr -d '"'"'" | tr -d '\r')
  fi
fi
[ -n "$CONNECTION" ] || fail 'No connection string. Pass -c, or set DATABASE_URL in backend/.env'

command -v pg_dump >/dev/null || fail 'pg_dump is not on PATH. Install the postgresql-client package.'
command -v python3 >/dev/null || fail 'python3 is required to parse the connection string.'

# Percent-decoded, because a password containing @ or / must be encoded in a URL.
eval "$(python3 - "$CONNECTION" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1])
if not p.hostname:
    print("fail=1"); raise SystemExit
print(f"DB_HOST={u.quote(p.hostname)}")
print(f"DB_PORT={p.port or 5432}")
print(f"DB_USER='{u.unquote(p.username or '')}'")
print(f"DB_PASS='{u.unquote(p.password or '')}'")
print(f"DB_NAME='{p.path.lstrip('/')}'")
PY
)"
[ -n "${DB_HOST:-}" ] || fail 'Could not read the connection string. Expected postgres://user:password@host:port/database'

log "Backing up $DB_NAME on $DB_HOST"
export PGPASSWORD="$DB_PASS"
trap 'unset PGPASSWORD' EXIT

# --- Refuse early if the client is older than the server ---------------------
# pg_dump will not dump a server newer than itself, which is easy to hit when a
# managed database upgrades underneath you. Say so plainly rather than failing
# cryptically in the middle of the night.
CLIENT_MAJOR=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
if command -v psql >/dev/null; then
  SERVER_VERSION=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc 'SHOW server_version' 2>/dev/null || true)
  if [ -n "$SERVER_VERSION" ]; then
    SERVER_MAJOR=$(echo "$SERVER_VERSION" | grep -oE '[0-9]+' | head -1)
    if [ "$CLIENT_MAJOR" -lt "$SERVER_MAJOR" ]; then
      fail "pg_dump is version $CLIENT_MAJOR but the server is $SERVER_MAJOR. Install PostgreSQL $SERVER_MAJOR client tools."
    fi
    log "pg_dump $CLIENT_MAJOR against server $SERVER_VERSION"
  fi
fi

# --- Dump --------------------------------------------------------------------
TARGET="$FOLDER/attendance-$(date +%Y-%m-%d-%H%M).dump"
pg_dump --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
        --format=custom --compress=9 --file="$TARGET" || fail "pg_dump exited with code $?"

# --- Verify it can actually be read back -------------------------------------
# A dump truncated by a full disk or a dropped connection looks fine on the
# filesystem. Reading the table of contents costs nothing and catches that now,
# rather than on the day it is needed.
if ! pg_restore --list "$TARGET" >/dev/null 2>&1; then
  rm -f "$TARGET"
  fail 'The dump could not be read back and has been deleted. Check disk space and connectivity.'
fi

log "Wrote $(basename "$TARGET") ($(du -h "$TARGET" | cut -f1)), verified readable"

# --- Prune -------------------------------------------------------------------
while IFS= read -r old; do
  [ -n "$old" ] || continue
  rm -f "$old"
  log "Pruned $(basename "$old") (older than $KEEP_DAYS days)"
done < <(find "$FOLDER" -maxdepth 1 -name 'attendance-*.dump' -mtime +"$KEEP_DAYS" 2>/dev/null)

log "Done. $(find "$FOLDER" -maxdepth 1 -name 'attendance-*.dump' | wc -l | tr -d ' ') backup(s) in $FOLDER"
