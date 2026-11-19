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
if ! command -v pg_ctl >/dev/null 2>&1; then
  # Debian/Ubuntu keep server binaries off PATH; newest version first.
  for d in $(printf "%s\n" /usr/lib/postgresql/*/bin | sort -t/ -k5 -n -r); do
    if [ -x "$d/pg_ctl" ]; then
      PATH="$d:$PATH"
      break
    fi
  done
fi
if ! command -v pg_ctl >/dev/null 2>&1; then
  echo "pg_ctl not found: install PostgreSQL 16+ or run 'docker compose up -d'" >&2
  exit 1
fi

# macOS postmaster aborts ("became multithreaded") without a valid locale.
if [ "$(uname -s)" = "Darwin" ]; then
  export LC_ALL="${LC_ALL:-en_US.UTF-8}"
fi

running() {
  pg_ctl -D "$PGDATA" status >/dev/null 2>&1
}

case "${1:-}" in
  start)
    mkdir -p "$ROOT/.tmp"
    # Serialize concurrent starts (initdb is not safe to run twice at once).
    LOCK="$ROOT/.tmp/pg.start.lock"
    acquired=0
    for _ in $(seq 1 120); do
      if mkdir "$LOCK" 2>/dev/null; then
        echo $$ >"$LOCK/pid"
        acquired=1
        break
      fi
      holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
      if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
        # Owner is dead (SIGKILL/reboot): break the lock atomically via rename.
        if mv "$LOCK" "$LOCK.dead.$$" 2>/dev/null; then
          rm -rf "$LOCK.dead.$$"
        fi
        continue
      fi
      sleep 0.5
    done
    if [ "$acquired" != 1 ]; then
      echo "timed out waiting for $LOCK (held by pid ${holder:-unknown})" >&2
      exit 1
    fi
    trap 'rm -rf "$LOCK"' EXIT
    if ! running && (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
      # Something else (e.g. docker compose) already serves this port.
      echo "$URL"
      exit 0
    fi
    if [ ! -f "$PGDATA/PG_VERSION" ]; then
      initdb -D "$PGDATA" -U teamkit --auth=trust -E UTF8 --locale=C >/dev/null
    fi
    if ! running; then
      if ! pg_ctl -D "$PGDATA" -o "-p $PORT -k /tmp -c max_connections=500" -l "$LOG" -w start >/dev/null; then
        # Another process may have started it concurrently.
        sleep 1
        running || { echo "failed to start postgres; see $LOG" >&2; exit 1; }
      fi
    fi
    exists="$(psql -X -h 127.0.0.1 -p "$PORT" -U teamkit -d postgres -tAc "select 1 from pg_database where datname='teamkit'")"
    if [ "$exists" != "1" ]; then
      createdb -h 127.0.0.1 -p "$PORT" -U teamkit teamkit || {
        # Lost a race with a concurrent start; fine if it exists now.
        [ "$(psql -X -h 127.0.0.1 -p "$PORT" -U teamkit -d postgres -tAc "select 1 from pg_database where datname='teamkit'")" = "1" ]
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
