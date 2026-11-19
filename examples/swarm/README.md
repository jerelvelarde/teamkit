# Swarm example

This example shows a small team of coding agents sharing one task board in AG-UI TeamKit.
A lead creates a plan. Workers each claim a task, run a real coding agent on it, and report back.
A reviewer waits until the work it reviews is done. When a worker gets stuck on a question, the lead answers it.

The plan in `plan.json` has three tasks:

- `limiter` (role `worker`): add a rate limiter.
- `docs` (role `worker`): document the API.
- `review` (role `reviewer`): review the limiter change. It needs `limiter`, so it stays waiting until `limiter` is completed.

Files:

- `plan.json`: the plan, in the format `teamkit tasks create --file` reads.
- `lead.sh`: creates the plan, then answers blocked tasks until every task is finished.
- `workers.sh`: one worker. It claims the next ready task, runs an agent on it, and repeats.
- `fake-agent.sh`: a stand-in agent that uses no model, for trying the example offline.

## Prerequisites

- Node 22 or newer, and the repository installed with `pnpm install`.
- A running server: `pnpm dev` (it starts the database and the server on port 8787).
- The `teamkit` command on your PATH. If it is not, point the scripts at the repository copy from the repository root:

  ```sh
  export TEAMKIT="node $PWD/packages/cli/bin/teamkit.mjs"
  ```

- For real agents, the `claude` command (Claude Code), signed in. The offline run needs nothing else.

## Create tokens

Each agent has its own token, and a token only does what its room grants allow. Run these from the
repository root. Each prints `name<TAB>token` lines, and this is the only time a token is shown, so save them.
`--silent` keeps pnpm's own banner out of the output.

```sh
# The lead creates tasks and answers questions.
pnpm --silent --filter @teamkit/server admin agents create lead --rooms build:read,post,create

# Three workers, named worker-1 to worker-3. They claim tasks.
pnpm --silent --filter @teamkit/server admin agents create worker --count 3 --rooms build:read,post,claim

# One reviewer.
pnpm --silent --filter @teamkit/server admin agents create reviewer --rooms build:read,post,claim
```

If the server uses a database other than the default, set `DATABASE_URL` to the same value for these commands.

## Run it

Every terminal needs the server address and its own token:

```sh
export TEAMKIT_URL=http://127.0.0.1:8787
export TEAMKIT_TOKEN=<that agent's token>
```

Terminal 1, the lead. It creates the plan and then waits:

```sh
examples/swarm/lead.sh
```

Terminals 2 and 3, two workers (use the `worker-1` and `worker-2` tokens). Each one claims `role=worker` tasks:

```sh
examples/swarm/workers.sh
```

Terminal 4, the reviewer (use the `reviewer` token):

```sh
ROLE=reviewer examples/swarm/workers.sh
```

Each worker runs `teamkit run --ready build --label role=<role> --wait 10m -- sh -c "<agent command>"`.
`teamkit run` claims a ready task, starts the agent with `TEAMKIT_TASK`, `TEAMKIT_URL` and `TEAMKIT_TOKEN` set,
keeps the claim alive while the agent runs, and completes the task when the agent exits 0 (or fails it on any other code).
The default agent command is `claude -p "$(cat "$PROMPT")"`, where the prompt is
`skills/teamkit/prompts/<role>.md`. The reviewer only gets `review` after `limiter` is completed.

Watch progress from any terminal that has a token:

```sh
teamkit tasks build --state all
```

### Settings

These environment variables change what the scripts do:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TEAMKIT` | `teamkit` | The command to run, for example `node packages/cli/bin/teamkit.mjs` |
| `ROOM` | `build` | The room that holds the tasks |
| `ROLE` | `worker` | `workers.sh` only: which label to claim, and which prompt to use |
| `PROMPT` | `skills/teamkit/prompts/$ROLE.md` | `workers.sh` only: the prompt file |
| `AGENT_CMD` | `claude -p "$(cat "$PROMPT")"` | `workers.sh` only: the agent command, run with `sh -c` |
| `PLAN` | `examples/swarm/plan.json` | `lead.sh` only: the plan to create |
| `LEAD_CMD` | `claude -p "$LEAD_TEXT"` | `lead.sh` only: run for each blocked task, with `TEAMKIT_TASK` set to the blocked thread |

Other agents work too: set `AGENT_CMD` to any command that reads its task from `TEAMKIT_TASK`.

### What the workers do when nothing is ready

`workers.sh` stops when `teamkit run` exits 130 (you pressed Ctrl-C). It prints "queue empty" and tries again when
nothing was ready within 10 minutes (exit 3), and it logs and continues on any other code.

### Questions that need a person

When a worker runs `teamkit tasks block <id> "<question>"`, the lead's `LEAD_CMD` reads the thread and answers it.
A task blocked with `--kind awaiting_approval` is different: it needs a person, and the lead's token is refused.
`lead.sh` reports the failure and keeps waiting; the person answers it, for example with `teamkit tasks answer <id> "go ahead"`.

## Try it with no model

`fake-agent.sh` reads the task, replies twice and exits 0, so `teamkit run` completes the task.
Set the agent command, and the rest is the same:

```sh
# Workers and reviewer
AGENT_CMD=examples/swarm/fake-agent.sh examples/swarm/workers.sh
AGENT_CMD=examples/swarm/fake-agent.sh ROLE=reviewer examples/swarm/workers.sh
```

The fake agent never asks a question, so the lead has nothing to answer and finishes once all three tasks are
completed. If `teamkit` is not on your PATH, export `TEAMKIT` first; the fake agent reads it too.
To see the lead answer a question without a model, set
`LEAD_CMD='teamkit tasks answer "$TEAMKIT_TASK" --choice pg'` and use an agent that blocks with
`teamkit tasks block "$TEAMKIT_TASK" "which db?" --options pg,sqlite`.
