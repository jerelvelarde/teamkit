#!/usr/bin/env bash
# One swarm worker: claim a ready task, run a coding agent on it, repeat.
# Run one copy per terminal, each from its own checkout of the repository the agents work on
# (for example a git worktree), never from the TeamKit repository. Set ROLE=reviewer for the reviewer.
set -euo pipefail

: "${TEAMKIT_URL:?set TEAMKIT_URL to the server address}"
: "${TEAMKIT_TOKEN:?set TEAMKIT_TOKEN to this worker token}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEAMKIT="${TEAMKIT:-teamkit}"
ROOM="${ROOM:-build}"
ROLE="${ROLE:-worker}"
PROMPT="${PROMPT:-$HERE/../../plugins/teamkit/skills/teamkit/prompts/$ROLE.md}"
# Claude Code with the tools a worker needs approved up front: `claude -p` cannot ask for them.
# The prompt gets the task id and room written in, because an allowed-tools rule never matches a
# command that contains a variable such as $TEAMKIT_TASK.
# shellcheck disable=SC2016
default_cmd='claude -p "$(sed "s|[$]TEAMKIT_TASK|$TEAMKIT_TASK|g; s|[$]TEAMKIT_ROOM|$TEAMKIT_ROOM|g" "$PROMPT")" --allowedTools "Bash(teamkit *)" "Bash(git *)" Read Edit Write Glob Grep'
AGENT_CMD="${AGENT_CMD:-$default_cmd}"
export PROMPT

# TEAMKIT may be a command with arguments, e.g. "node packages/cli/bin/teamkit.mjs".
# shellcheck disable=SC2206
TEAMKIT_ARGV=($TEAMKIT)

if [ "$AGENT_CMD" = "$default_cmd" ]; then
  # The default agent edits the files where it runs, so keep it out of the TeamKit checkout itself.
  top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$top" ] && [ "$(cd "$top" && pwd -P)" = "$(cd "$HERE/../.." && pwd -P)" ]; then
    echo "run workers.sh from this worker's own checkout of the target repository, not from TeamKit" >&2
    exit 2
  fi
  # A signed-out claude exits 1, and run would fail every task it took: check before claiming any.
  if ! claude auth status >/dev/null 2>&1; then
    echo "claude is not installed or not signed in (see claude auth status); sign in, then start again" >&2
    exit 4
  fi
fi

delay=5
while true; do
  code=0
  "${TEAMKIT_ARGV[@]}" run --ready "$ROOM" --label "role=$ROLE" --wait 10m -- sh -c "$AGENT_CMD" || code=$?
  case "$code" in
    0) delay=5 ;;
    3) delay=5; echo "queue empty" ;;
    4)
      echo "the agent command could not start, so the task was released; fix AGENT_CMD and start again" >&2
      exit 4
      ;;
    129 | 130) exit "$code" ;;
    *)
      # A failed task, or a server that is down: wait before the next claim, longer each time.
      echo "teamkit run exited with code $code, trying again in ${delay}s" >&2
      sleep "$delay"
      delay=$((delay * 2 > 60 ? 60 : delay * 2))
      ;;
  esac
done
