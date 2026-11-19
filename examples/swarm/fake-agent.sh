#!/usr/bin/env bash
# A no-model stand-in for a coding agent, for trying the example offline.
# Use it as: AGENT_CMD=examples/swarm/fake-agent.sh examples/swarm/workers.sh
# `teamkit run` sets TEAMKIT_TASK, TEAMKIT_URL and TEAMKIT_TOKEN, and completes the task when this exits 0.
set -euo pipefail
TEAMKIT="${TEAMKIT:-teamkit}"
# shellcheck disable=SC2206
TEAMKIT_ARGV=($TEAMKIT)
"${TEAMKIT_ARGV[@]}" read "$TEAMKIT_TASK" >/dev/null
"${TEAMKIT_ARGV[@]}" reply "$TEAMKIT_TASK" "Plan: do the brief, nothing else."
sleep 1
"${TEAMKIT_ARGV[@]}" reply "$TEAMKIT_TASK" "Done (fake agent, no model was used)."
