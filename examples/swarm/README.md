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

- For real agents, the `claude` command (Claude Code), signed in (`claude auth status` exits 0), and `teamkit` itself on your PATH: the agents are
  allowed to run `teamkit ...` commands, and `node .../teamkit.mjs` is not one. One way, from the repository root:
  `ln -s "$PWD/packages/cli/bin/teamkit.mjs" ~/.local/bin/teamkit` (any directory on your PATH works).
  The offline run needs none of this.

## Create tokens

Each agent has its own token, and a token only does what its room grants allow. Run these from the
repository root. Each prints `name<TAB>token` lines, and this is the only time a token is shown, so save them.
`--silent` keeps pnpm's own banner out of the output.

```sh
# The lead creates tasks and answers questions. It is called lead-cli so the name stays free for
# an AG-UI lead agent (see examples/service-agent).
pnpm --silent --filter @teamkit/server admin agents create lead-cli --rooms build:read,post,create

# Three workers, named worker-1 to worker-3. They claim tasks.
pnpm --silent --filter @teamkit/server admin agents create worker --count 3 --rooms build:read,post,claim

# One reviewer.
pnpm --silent --filter @teamkit/server admin agents create reviewer --rooms build:read,post,claim
```

If the server uses a database other than the default, set `DATABASE_URL` to the same value for these commands.

## Give each worker its own checkout

Real agents edit files and run git where they start. Give every worker its own checkout of the repository the
agents work on, so two agents never edit the same files and nothing lands in the TeamKit repository itself.
With git worktrees of your project (here `~/code/myapp`):

```sh
cd ~/code/myapp
git worktree add ../work-1
git worktree add ../work-2
git worktree add ../review-1
```

Start each worker from its own directory: `cd ~/code/work-1`, then run `workers.sh` by its full path.
`workers.sh` refuses to start the default agent inside the TeamKit repository.

## Run it

Every terminal needs the server address and its own token:

```sh
export TEAMKIT_URL=http://127.0.0.1:8787
export TEAMKIT_TOKEN=<that agent's token>
```

Terminal 1, the lead (use the `lead-cli` token). It creates the plan and then waits:

```sh
examples/swarm/lead.sh
```

Terminals 2 and 3, two workers (use the `worker-1` and `worker-2` tokens). Each one claims `role=worker` tasks,
from its own worktree (`TEAMKIT_HOME` here is wherever you cloned TeamKit):

```sh
cd ~/code/work-1   # work-2 in the other terminal
"$TEAMKIT_HOME"/examples/swarm/workers.sh
```

Terminal 4, the reviewer (use the `reviewer` token):

```sh
cd ~/code/review-1
ROLE=reviewer "$TEAMKIT_HOME"/examples/swarm/workers.sh
```

Each worker runs `teamkit run --ready build --label role=<role> --wait 10m -- sh -c "<agent command>"`.
`teamkit run` claims a ready task, starts the agent with `TEAMKIT_TASK`, `TEAMKIT_URL` and `TEAMKIT_TOKEN` set,
and keeps the claim alive while the agent runs. The agent settles the task itself, with
`teamkit tasks complete <id> "<result>"`, `fail` or `block`. If it exits without doing so, `run` fails the task on a
non-zero exit, and on exit 0 completes it with the result "agent exited 0 without completing".
The reviewer only gets `review` after `limiter` is completed.

The default agent command is:

```sh
claude -p "$(sed "s|[$]TEAMKIT_TASK|$TEAMKIT_TASK|g; s|[$]TEAMKIT_ROOM|$TEAMKIT_ROOM|g" "$PROMPT")" \
  --allowedTools "Bash(teamkit *)" "Bash(git *)" Read Edit Write Glob Grep
```

The prompt is `skills/teamkit/prompts/<role>.md`. `claude -p` cannot ask for permission, so `--allowedTools`
approves what a worker needs up front: `teamkit` and `git` commands, and reading and editing files. Without it the
agent can do nothing and exits 0. The prompt comes first because `--allowedTools` takes every argument after it.
The `sed` writes the task id and room into the prompt: an allowed-tools rule never matches a command that contains a
variable, so the agent has to type `teamkit read th_...` rather than `teamkit read $TEAMKIT_TASK`.

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
| `AGENT_CMD` | the command above | `workers.sh` only: the agent command, run with `sh -c` |
| `PLAN` | `examples/swarm/plan.json` | `lead.sh` only: the plan to create |
| `LEAD_CMD` | `claude -p "$LEAD_TEXT" --allowedTools "Bash(teamkit *)" Read Glob Grep` | `lead.sh` only: run for each blocked task, with `TEAMKIT_TASK` set to the blocked thread |

Other agents work too: set `AGENT_CMD` to any command that reads its task from `TEAMKIT_TASK`.

### What the workers do after each task

`workers.sh` looks at how `teamkit run` exited:

| Exit | Meaning | `workers.sh` |
| --- | --- | --- |
| `0` | the task was completed or blocked | takes the next task |
| `3` | nothing was ready within 10 minutes | prints "queue empty" and waits again |
| `4` | the agent command could not start (not found, not executable, `claude` not installed) | stops; the task was released for another worker |
| `129` | the terminal was closed | stops; the agent was stopped and the task released |
| `130` | you pressed Ctrl-C | stops |
| other | the task failed, or the server could not be reached | waits 5 s, doubling up to 60 s, then tries again |

A `claude` that is installed but signed out is not exit 4: it starts, prints "Not logged in" and exits 1, so `run`
fails the task and the worker backs off and fails the next one. With the default agent command, `workers.sh` runs
`claude auth status` first and stops if you are not signed in; with your own `AGENT_CMD`, check the sign-in
yourself before starting workers.

Ctrl-C reaches the agent once, through `teamkit run`, which releases the task when the agent has stopped.
Press Ctrl-C a second time to kill the agent at once. Closing the terminal does the same as one Ctrl-C.
Ctrl-Z pauses the agent along with `teamkit run`, and `fg` resumes both; while paused, the claim is not renewed,
so after the lease (5 minutes by default) another worker may take the task.

### Questions that need a person

When a worker runs `teamkit tasks block <id> "<question>"`, the lead's `LEAD_CMD` reads the thread and answers it
with `teamkit tasks answer`. The question and the answer both stay in the thread, so the worker that picks the task up
again reads them in order.
A task blocked with `--kind awaiting_approval` is different: only a person signed in to the board can answer it.
No token can, the lead's included (`teamkit tasks answer` fails with `approval_requires_person`). `lead.sh` reports
the failure and keeps waiting; the person approves it on the web board or in Slack.

If a task fails, the tasks that need it can never run. `lead.sh` reports them as stuck, and when nothing else is
left to finish it exits 1.

## Try it with no model

`fake-agent.sh` reads the task, replies twice and completes it. It edits nothing, so it can run from the repository
root. Set the agent command, and the rest is the same:

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
