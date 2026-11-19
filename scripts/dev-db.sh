#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA="$ROOT/.tmp/pg"
LOG="$ROOT/.tmp/pg.log"
PORT=54329
URL="postgres://teamkit@127.0.0.1:$PORT/teamkit"

if ! command -v pg_ctl >/dev/null 2>&1; then
  for d in /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin /opt/homebrew/bin; do
    if [ -d "$d" ]; then
      PATH="$d:$PATH"
      break
    fi
  done
fi

# macOS postmaster aborts ("became multithreaded") without a valid locale.
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

running() {
  pg_ctl -D "$PGDATA" status >/dev/null 2>&1
}

case "${1:-}" in
  start)
    mkdir -p "$ROOT/.tmp"
    # Serialize concurrent starts (initdb is not safe to run twice at once).
    LOCK="$ROOT/.tmp/pg.start.lock"
    for _ in $(seq 1 120); do
      mkdir "$LOCK" 2>/dev/null && break
      sleep 0.5
    done
    trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
    if [ ! -f "$PGDATA/PG_VERSION" ]; then
      initdb -D "$PGDATA" -U teamkit --auth=trust >/dev/null
    fi
    if ! running; then
      if ! pg_ctl -D "$PGDATA" -o "-p $PORT -k /tmp -c max_connections=500" -l "$LOG" -w start >/dev/null; then
        # Another process may have started it concurrently.
        sleep 1
        running || { echo "failed to start postgres; see $LOG" >&2; exit 1; }
      fi
    fi
    exists="$(psql -h 127.0.0.1 -p "$PORT" -U teamkit -d postgres -tAc "select 1 from pg_database where datname='teamkit'")"
    if [ "$exists" != "1" ]; then
      createdb -h 127.0.0.1 -p "$PORT" -U teamkit teamkit 2>/dev/null || {
        # Lost a race with a concurrent start; fine if it exists now.
        [ "$(psql -h 127.0.0.1 -p "$PORT" -U teamkit -d postgres -tAc "select 1 from pg_database where datname='teamkit'")" = "1" ]
      }
    fi
    echo "$URL"
    ;;
  stop)
    if running; then
      pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null
    fi
    ;;
  url)
    echo "$URL"
    ;;
  *)
    echo "usage: $0 start|stop|url" >&2
    exit 2
    ;;
esac
