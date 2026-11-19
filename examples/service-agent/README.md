# TeamKit example service agents

AG-UI agents that AG-UI TeamKit's dispatcher calls over HTTP. Each agent is a
`POST` endpoint that takes a `RunAgentInput` and streams AG-UI events as SSE.
None of them needs a model key except `researcher`.

Run the server (default port 8790):

```sh
pnpm --filter @teamkit/example-service-agent start
```

`GET /healthz` lists the agents it serves.

## approver

A scripted agent for the approval flow. Its first run states a plan for the
task and stops with an interrupt (`awaiting_approval`, choices `approve` or
`reject`). When the run resumes, it says "Shipped." on approve or "Stopped."
otherwise, and finishes.

Register it and attach it to a room. These commands use `teamkit-admin`, which works on the
server's database directly (run them from the repository root, with the same `DATABASE_URL` as the server).
Its flag for the agent's address is `--url`:

```sh
pnpm --silent --filter @teamkit/server admin agents register approver --url http://127.0.0.1:8790/approver --rooms ship
pnpm --silent --filter @teamkit/server admin rooms set ship --agent approver --approvers <you>
```

If you have signed in with `teamkit login`, the `teamkit` command does the same, but its flag is
`--agent-url` (there `--url` is the TeamKit server):

```sh
teamkit agents register approver --agent-url http://127.0.0.1:8790/approver --rooms ship
teamkit rooms set ship --agent approver --approvers <you>
```

## researcher

A live-model agent that works a task with the board tools (`teamkit_reply`,
`teamkit_label` and the rest the dispatcher passes in). Each run makes one
OpenAI Chat Completions call and turns the answer into AG-UI events: tool
calls for the dispatcher to run, or a final summary. After 8 tool results it
stops offering tools so the run can finish.

It is mounted only when `OPENAI_API_KEY` is set; otherwise `POST /researcher`
returns 404 and `/healthz` does not list it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | none | Turns the agent on. |
| `TEAMKIT_MODEL` | `gpt-5.6-sol` | Model id. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any Chat Completions compatible API. |
| `OPENAI_TIMEOUT_MS` | `60000` | How long one model call may take before the run ends with an error. |

Export the key in the shell that starts the agents (this example does not read `.env`):

```sh
export OPENAI_API_KEY=...
pnpm --filter @teamkit/example-service-agent start
```

Never write the key to a file in the repo.

```sh
pnpm --silent --filter @teamkit/server admin agents register researcher --url http://127.0.0.1:8790/researcher --rooms research
```

## lead

A scripted agent that acts as a room's lead. TeamKit wakes it with a message like
`Task th_0123456789abcdef in build/ is now blocked: ...`. On a blocked task it reads the
thread with `teamkit_read`. A `needs_input` question gets `teamkit_answer` with the first
option, or "Go with your recommendation." when there are no options. Approvals need a
person, so it leaves those alone. For any other state it just notes it. It calls the board
tools as client-side AG-UI tools and finishes the run; the dispatcher runs them and calls it
again with the results.

```sh
pnpm --silent --filter @teamkit/server admin agents register lead --url http://127.0.0.1:8790/lead --rooms build
pnpm --silent --filter @teamkit/server admin triggers add lead-wake --room build/ --kinds task.blocked,task.completed,task.failed --agent lead
```

The agent name `lead` is taken by this agent. If you also run the swarm example, its token is
called `lead-cli` for that reason. Do not run both against the same room at once: the server's
dispatcher would hand the room's tasks to `lead` while the swarm workers are claiming them.
