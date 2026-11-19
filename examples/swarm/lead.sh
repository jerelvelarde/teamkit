#!/usr/bin/env bash
# The swarm lead: create the plan, then answer blocked tasks until nothing is left.
set -euo pipefail

: "${TEAMKIT_URL:?set TEAMKIT_URL to the server address}"
: "${TEAMKIT_TOKEN:?set TEAMKIT_TOKEN to the lead token}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEAMKIT="${TEAMKIT:-teamkit}"
ROOM="${ROOM:-build}"
PLAN="${PLAN:-$HERE/plan.json}"
LEAD_PROMPT="${LEAD_PROMPT:-$HERE/../../plugins/teamkit/skills/teamkit/prompts/lead.md}"
# LEAD_CMD runs for each blocked task with TEAMKIT_TASK (the blocked thread), TEAMKIT_ROOM and LEAD_TEXT set.
# The lead only needs teamkit and reading; `claude -p` cannot ask for tools, so they are approved up front.
# shellcheck disable=SC2016
default_cmd='claude -p "$LEAD_TEXT" --allowedTools "Bash(teamkit *)" Read Glob Grep'
LEAD_CMD="${LEAD_CMD:-$default_cmd}"

# shellcheck disable=SC2206
TEAMKIT_ARGV=($TEAMKIT)
json_get() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=process.argv[1].split(".").reduce((o,k)=>o?.[k],v);process.stdout.write(String(r??""))})' "$1"; }
# Reads `tasks --json` and prints the number of open tasks, then the ids of stuck ones: waiting tasks
# that can never run because a task they need failed, directly or further down the chain.
board_state() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const tasks = JSON.parse(s);
      const stuck = new Set();
      for (let grew = true; grew; ) {
        grew = false;
        for (const t of tasks) {
          if (t.state !== "waiting" || stuck.has(t.id)) continue;
          if (t.needs.some((n) => t.needStates[n] === "failed" || stuck.has(n))) {
            stuck.add(t.id);
            grew = true;
          }
        }
      }
      const open = ["waiting", "ready", "claimed", "blocked"];
      const count = tasks.filter((t) => open.includes(t.state) && !stuck.has(t.id)).length;
      process.stdout.write([count, ...stuck].join(" "));
    });
  '
}

# Take the cursor before creating the plan so no event is missed. A room that does not exist yet has no events.
cursor="$("${TEAMKIT_ARGV[@]}" read "$ROOM" --json 2>/dev/null | json_get cursor 2>/dev/null || true)"
cursor="${cursor:-0}"
"${TEAMKIT_ARGV[@]}" tasks create "$ROOM" --file "$PLAN" --json
echo "plan created, waiting for blocked, completed and failed tasks" >&2
reported=""

while true; do
  code=0
  event="$("${TEAMKIT_ARGV[@]}" wait "$ROOM" --kind task.blocked --kind task.completed --kind task.failed \
    --after "$cursor" --timeout 10m --json)" || code=$?
  if [ "$code" -eq 3 ]; then echo "nothing for 10 minutes, still waiting" >&2; continue; fi
  [ "$code" -eq 0 ] || exit "$code"
  cursor="$(printf '%s' "$event" | json_get cursor)"
  kind="$(printf '%s' "$event" | json_get kind)"
  thread="$(printf '%s' "$event" | json_get threadId)"
  echo "$kind $thread" >&2
  if [ "$kind" = "task.blocked" ]; then
    # An awaiting_approval block needs a person: the lead's token is refused and the command fails.
    # Write the ids into the prompt: an allowed-tools rule never matches a command with a variable in it.
    LEAD_TEXT="$(cat "$LEAD_PROMPT")"
    LEAD_TEXT="${LEAD_TEXT//\$TEAMKIT_TASK/$thread}"
    LEAD_TEXT="${LEAD_TEXT//\$TEAMKIT_ROOM/$ROOM}"$'\n\n'"The blocked task for this run is $thread. Do steps 2 and 3 for that task only. Do not complete it."
    export LEAD_TEXT
    TEAMKIT_TASK="$thread" TEAMKIT_ROOM="$ROOM" sh -c "$LEAD_CMD" || echo "lead command failed on $thread" >&2
  fi
  state="$("${TEAMKIT_ARGV[@]}" tasks "$ROOM" --state all --json | board_state)"
  read -r open stuck <<<"$state"
  if [ -n "$stuck" ] && [ "$stuck" != "$reported" ]; then
    echo "stuck, a task they need failed: $stuck" >&2
    reported="$stuck"
  fi
  if [ "$open" -eq 0 ]; then
    if [ -n "$stuck" ]; then echo "nothing else can finish; stopping with stuck tasks" >&2; exit 1; fi
    echo "all tasks are finished" >&2
    break
  fi
done
