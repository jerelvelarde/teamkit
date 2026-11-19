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
