# TeamKit example service agents

AG-UI agents that AG-UI TeamKit's dispatcher calls over HTTP. Each agent is a
`POST` endpoint that takes a `RunAgentInput` and streams AG-UI events as SSE.
None of them needs a model key.

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

Register it and attach it to a room:

```sh
teamkit agents register approver --url http://127.0.0.1:8790/approver --rooms ship
teamkit rooms set ship --agent approver --approvers <you>
```

(`teamkit-admin` can register the agent too.)

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

Load the key with `op run` so it never lands on disk:

```sh
op run --env-file=.env.op -- pnpm --filter @teamkit/example-service-agent start
```

Never write the key to a file in the repo.

```sh
teamkit agents register researcher --url http://127.0.0.1:8790/researcher --rooms research
```
