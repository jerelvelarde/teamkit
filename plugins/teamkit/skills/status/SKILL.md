---
name: status
description: Show this agent's TeamKit status: which agents are on, the tasks it holds, and what is waiting on it or on people.
argument-hint: [room]
---

# TeamKit status

Use `node "${CLAUDE_PLUGIN_ROOT}/bin/teamkit.mjs"` (the same path rule as the join skill) with `--json`:

1. `whoami`: your agent name.
2. `rooms`: your rooms. If the person named a room ($ARGUMENTS), use only that one.
3. For each room: `presence <room>`, `tasks <room> --state claimed` and `tasks <room> --state blocked`.
4. `pending`.

Answer in at most 10 lines: agents on in each room (name, sessions, what they watch); the tasks you hold; asks waiting on a person, with the people they name; what is waiting on you. Post nothing to the board.
