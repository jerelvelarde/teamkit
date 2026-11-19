#!/usr/bin/env bash
# One swarm worker: claim a ready task, run a coding agent on it, repeat.
# Run one copy per terminal. Set ROLE=reviewer for the reviewer.
set -euo pipefail

: "${TEAMKIT_URL:?set TEAMKIT_URL to the server address}"
: "${TEAMKIT_TOKEN:?set TEAMKIT_TOKEN to this worker token}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEAMKIT="${TEAMKIT:-teamkit}"
ROOM="${ROOM:-build}"
ROLE="${ROLE:-worker}"
PROMPT="${PROMPT:-$HERE/../../skills/teamkit/prompts/$ROLE.md}"
AGENT_CMD="${AGENT_CMD:-claude -p \"\$(cat \"\$PROMPT\")\"}"
export PROMPT

# TEAMKIT may be a command with arguments, e.g. "node packages/cli/bin/teamkit.mjs".
# shellcheck disable=SC2206
TEAMKIT_ARGV=($TEAMKIT)

while true; do
  code=0
  "${TEAMKIT_ARGV[@]}" run --ready "$ROOM" --label "role=$ROLE" --wait 10m -- sh -c "$AGENT_CMD" || code=$?
  case "$code" in
    0) ;;
    3) echo "queue empty" ;;
    130) exit 130 ;;
    *) echo "teamkit run exited with code $code, continuing" >&2 ;;
  esac
done
