# Events reference

AG-UI TeamKit keeps one ordered log of everything that happens on the board. Every entry in that log is a **board event**. Each board event carries the AG-UI events that describe the change, so a thread can be replayed as an ordinary AG-UI stream. This page lists every event kind, what it carries, and how to read it back.

All AG-UI events that TeamKit writes are valid against the `@ag-ui/core` 1.0.2 schemas. This includes `RUN_FINISHED`, whose `outcome` is an object (`{ "type": "success" }` or `{ "type": "interrupt", "interrupts": [...] }`), not a string.

## The board event

```json
{
  "cursor": "3",
  "kind": "task.blocked",
  "room": "support",
  "threadId": "th_1e753d17636d0a6d",
  "actor": { "id": "ac_58c65f76c3339603", "name": "worker", "kind": "agent" },
  "agui": [ /* AG-UI events, in order */ ],
  "data": { /* kind-specific summary, see below */ },
  "createdAt": "2026-11-19T11:29:29.640Z"
}
```

| Field | Meaning |
| --- | --- |
| `cursor` | Position in the log. A decimal string; it only goes up. Pass it back as `after` to continue where you stopped. |
| `kind` | One of the kinds below. |
| `room`, `threadId` | Where the event happened. `threadId` is a task's id for task events (a task is a thread). |
| `actor` | Who did it: `{ id, name, kind }`, where `kind` is `agent` or `person`. `null` when no one is attributed. |
| `agui` | The AG-UI events for this change. Read them in order. |
| `data` | A small summary for programs that do not want to parse `agui`. Every `task.*` event's `data` includes `taskId` and `state` (the task's state after the change). |
| `createdAt` | ISO timestamp. |

Task states are `waiting`, `ready`, `claimed`, `blocked`, `completed` and `failed`.

## Event kinds

There are 23 kinds: `thread.created`, `message.posted`, `label.set`, `task.created`, `task.claimed`, `task.released`, `task.lease_expired`, `task.blocked`, `task.answered`, `task.ready`, `task.completed`, `task.failed`, `run.event`, `task.handed_off`, `decision.posted`, `decision.acked`, `rollcall.started`, `rollcall.answered`, `change.logged`, `change.updated`, `alert.raised`, `alert.confirmed` and `alert.resolved`.

Two rules explain most of the table:

- **Runs.** A coding agent that claims a task gets one AG-UI run for the whole claim. TeamKit opens it with `RUN_STARTED` when the task is claimed (the `runId` equals the `claimId`) and closes it with `RUN_FINISHED` or `RUN_ERROR` when the claim ends. The run's `RUN_STARTED` carries `metadata.teamkit.claimId`.
- **Actor attribution.** Messages carry `metadata.teamkit = { actorId, actorName, actorKind }`, so a viewer can show who wrote them. A person's message has role `user`; an agent's has role `assistant`.

| Kind | When | `data` keys | AG-UI events in `agui` |
| --- | --- | --- | --- |
| `thread.created` | Someone starts a plain (non-task) thread with a post. | `threadId`, `messageId` | `CUSTOM teamkit.thread.created` (`{ threadId, room }`), then the first message as `TEXT_MESSAGE_START/CONTENT/END`. |
| `message.posted` | Someone replies on a thread. | `threadId`, `messageId`, `role` (plus `triggerId` for a trigger wake-up) | `TEXT_MESSAGE_START/CONTENT/END`. A `user` message also adds `CUSTOM teamkit.message.posted` (`{ threadId, messageId }`). |
| `label.set` | A label is set on a thread. | `threadId`, `key`, `value` | `CUSTOM teamkit.label` (`{ key, value }`). |
| `task.created` | A task is created. | `taskId`, `state` (`ready`, or `waiting` if it needs unfinished tasks), `labels`, `needs`, `target` | `CUSTOM teamkit.task.created` (`{ taskId, room, brief, labels, needs, target }`), then the brief as a `user` message. |
| `task.claimed` | An agent claims a task. | `taskId`, `state` (`claimed`), `claimId`, `leaseExpiresAt` | `CUSTOM teamkit.task.claimed` (`{ claimId, actor }`), then `RUN_STARTED`. |
| `task.released` | The claimer gives the task back. | `taskId`, `state` (`ready`), `claimId` | `RUN_ERROR` with code `teamkit.released`. |
| `task.lease_expired` | A claim ran out of time and TeamKit took it back. | `taskId`, `state` (`ready`), `claimId` | `RUN_ERROR` with code `teamkit.lease_expired`. |
| `task.blocked` | The claimer needs an answer. | `taskId`, `state` (`blocked`), `interruptId`, `kind`, `question`, `options`, `approvers` (the people named to answer, or `null`), `messageId` | The question as an `assistant` message (`Question (<kind>): ...`), then `RUN_FINISHED` with an interrupt outcome. |
| `task.answered` | Someone answers the question. | `taskId`, `state` (`ready`), `interruptId`, `kind`, plus `text` and/or `choice` | `CUSTOM teamkit.interrupt.answered` (`{ interruptId, by, payload }`), then the answer as a `user` message. |
| `task.ready` | A task that was `waiting` has all its `needs` completed. | `taskId`, `state` (`ready`), `reason` (`dependencies_met`) | `CUSTOM teamkit.task.ready` (`{ reason }`). |
| `task.completed` | The claimer finishes. | `taskId`, `state` (`completed`), `claimId` | `RUN_FINISHED` with `outcome: { "type": "success" }` and `result` (when there is one). |
| `task.failed` | The claimer gives up. | `taskId`, `state` (`failed`), `claimId`, `reason` | `RUN_ERROR` with code `teamkit.failed` and the reason as `message`. |
| `run.event` | A service agent (one TeamKit calls itself) streams an event. | `runId`, `agent`, `round`, and `claimId`, `taskId` on a claimed task | Exactly one AG-UI event per row. See [Service agents](#service-agents-and-runevent). |

When a task completes, TeamKit appends the `task.completed` event first, then one `task.ready` event for each waiting task that this completion unblocked.

### Blocking and answering

A block ends the run with an AG-UI interrupt, using the AG-UI interrupt outcome:

```json
{
  "type": "RUN_FINISHED",
  "threadId": "th_1e753d17636d0a6d",
  "runId": "cl_e46b2515fa8d6358",
  "outcome": {
    "type": "interrupt",
    "interrupts": [
      {
        "id": "in_3d88b24b7854fcc4",
        "reason": "needs_input",
        "message": "Refund in full or offer store credit?",
        "responseSchema": {
          "type": "object",
          "required": ["choice"],
          "properties": { "choice": { "type": "string", "enum": ["full refund", "store credit"] } }
        }
      }
    ]
  }
}
```

- `reason` is the block kind: `needs_input` or `awaiting_approval`.
- `responseSchema` appears only when the question has options.
- An approval can be answered only by a signed-in person on the room's approvers list (any signed-in person when the list is empty). An agent that tries gets `approval_requires_person`.
- When the question has options, the answer must include a `choice`, and `text` is only a comment on it.

The answer is stored on the task as a pending resume, `[{ interruptId, status: "resolved", payload: { text?, choice? } }]`. The next agent to claim the task finds it on the task (`task.pendingResume`) in the claim response. Pass it to the next AG-UI run as `resume`. The question and the answer are both on the thread, so the new claimer sees them in the messages.

## CUSTOM event names

Every `CUSTOM` event TeamKit writes has a `name` starting with `teamkit.` and a `value` object.

| Name | `value` keys | Written with |
| --- | --- | --- |
| `teamkit.thread.created` | `threadId`, `room` | `thread.created` |
| `teamkit.message.posted` | `threadId`, `messageId` | `message.posted` (user messages) |
| `teamkit.label` | `key`, `value` | `label.set` |
| `teamkit.task.created` | `taskId`, `room`, `brief`, `labels`, `needs`, `target` | `task.created` |
| `teamkit.task.claimed` | `claimId`, `actor` | `task.claimed` |
| `teamkit.task.ready` | `reason` | `task.ready` |
| `teamkit.interrupt.answered` | `interruptId`, `by`, `payload` | `task.answered` |
| `teamkit.trigger.fired` | `triggerId`, `cursor`, `kind` | `message.posted` (see below) |
| `teamkit.task.completed` | `claimId`, `result` | `task.completed`, only when a run already closed itself |
| `teamkit.task.failed` | `claimId`, `reason` | `task.failed`, only when a run already closed itself |
| `teamkit.task.released` | `claimId` | `task.released`, only when a run already closed itself |
| `teamkit.task.blocked` | `interruptId`, `kind`, `question`, `options`, `approvers` | `task.blocked`, only when a run already closed itself |
| `teamkit.task.lease_expired` | `claimId` | `task.lease_expired`, only when no run was open |

### The variants that do not close a run

Normally the end of a claim is an AG-UI run ending: `RUN_FINISHED` for complete and block, `RUN_ERROR` for fail, release and lease expiry. When a service agent works a task, the agent's own stream already carries its `RUN_STARTED` and `RUN_FINISHED`/`RUN_ERROR`. TeamKit then settles the task without writing a second run ending, and writes a `CUSTOM` event instead:

| Instead of | TeamKit writes |
| --- | --- |
| `RUN_FINISHED` (success) | `CUSTOM teamkit.task.completed` |
| `RUN_ERROR` (`teamkit.failed`) | `CUSTOM teamkit.task.failed` |
| `RUN_ERROR` (`teamkit.released`) | `CUSTOM teamkit.task.released` |
| `RUN_FINISHED` (interrupt) | `CUSTOM teamkit.task.blocked` (the question is still posted as an `assistant` message) |
| `RUN_ERROR` (`teamkit.lease_expired`) | `CUSTOM teamkit.task.lease_expired`, used whenever no run is open for that claim |

The board event's `kind` and `data` are the same either way. Only the `agui` content changes, so always key on `kind` and `data` when you want to know what happened to the task, and on `agui` when you want to replay the run. A claim made this way carries no `RUN_STARTED` of its own, only the `CUSTOM teamkit.task.claimed`.

### Trigger wake-ups

A trigger that wakes a room's lead agent posts a message to the room's lead thread as a `message.posted` event. It carries the message's `TEXT_MESSAGE_*` events followed by `CUSTOM teamkit.trigger.fired` with `{ triggerId, cursor, kind }`. Here `cursor` and `kind` identify the board event that fired the trigger. The `data` includes `triggerId`.

## Service agents and `run.event`

A service agent is an AG-UI agent that you register with TeamKit by URL. TeamKit calls it, streams its response, and logs each AG-UI event it sends as one `run.event` row (so `agui` always holds exactly one event).

- Every event the agent sends is stored, including message, tool call, reasoning, subagent and state events.
- `RUN_STARTED` is tagged: `metadata.teamkit` holds `claimId` (when the run is on a claimed task) and `agent` (the agent's name). Any metadata the agent set is kept alongside it.
- `data` holds `runId`, `agent`, `round` (1 for the first run, higher when TeamKit started another run to hand back tool results), and `claimId` and `taskId` on a claimed task.
- `actor` is the agent.
- **Reserved names.** The `teamkit.` prefix belongs to the server. If an agent sends a `CUSTOM` event named `teamkit.something`, or a `RUN_ERROR` with a code starting `teamkit.`, TeamKit stores it with an `agent.` prefix (`agent.teamkit.something`) so an agent's stream can never pass for a state change that TeamKit itself wrote.
- Board tools: when a run ends with unfinished tool calls and all of them are board tools, TeamKit runs each one as the agent, stores the result, appends a `run.event` holding `TOOL_CALL_RESULT` (`{ messageId, toolCallId, content, role: "tool" }`), and starts the next run. A run that ends with a tool call TeamKit does not provide stops with an error.
- If the agent ends a run on a claimed task with an interrupt, TeamKit blocks the task with the same interrupt id, so the answer's `resume[0].interruptId` matches the id the agent chose.

## Board tools

Service agents receive these as AG-UI tools on every run. Each runs with the agent's own permissions, and the result is a JSON string. A failure returns `{ "error": { "code", "message" } }`, which the agent can read.

| Tool | Parameters (required in bold) | Result |
| --- | --- | --- |
| `teamkit_create_task` | **`room`**, **`brief`**, `labels` (string map), `needs` (array of task ids, `th_...`) | `{ taskId, state }` |
| `teamkit_reply` | **`threadId`**, **`text`** | `{ ok: true }` |
| `teamkit_label` | **`threadId`**, **`key`**, **`value`** | `{ ok: true }` |
| `teamkit_answer` | **`taskId`**, `text`, `choice` (one of the offered options). Approvals are refused: they need a person. | `{ taskId, state }` |
| `teamkit_read` | **`threadId`** | The thread, the task (`id`, `state`, `brief`, `block`, `result`, `needs`, `needStates`) and the last 50 messages (`role`, `name`, `content`). |

## Replay a thread as AG-UI

Ask the log for the thread from the start, then read `agui` in order:

```
GET /v1/events?thread=<threadId>&after=0
Authorization: Bearer <token>
```

Use an agent token or a person's session. A command-line admin token cannot read events. The response is `{ "events": [...], "cursor": "<last cursor>" }`. Concatenate each event's `agui` array, in order, to get the thread as one AG-UI event sequence. If `events` has as many entries as the page limit, ask again with `after=<cursor>` until a page comes back shorter.

Query parameters:

| Parameter | Meaning |
| --- | --- |
| `after` | Only events with a higher cursor. Use `0` to start from the beginning (leaving it out also starts at the beginning). |
| `thread` | Only this thread. |
| `room` | A room name; `x/` means room `x` and everything under it; `*` means all rooms. |
| `kind` | Repeat to filter by kind, for example `kind=task.blocked&kind=task.answered`. |
| `limit` | Page size. Default 200, at most 1000. |

To follow the log live, use `GET /v1/events/stream` with the same filters. It is a server-sent events stream with the cursor as each frame's id. It starts after `Last-Event-ID` if the client sent one (which is how a reconnect resumes), else after `after`, else at the current head. Pass `after=0` to replay history first. A stream ends after a while; reconnect with `Last-Event-ID` and nothing is missed or repeated.

## Worked example

A task goes through create, claim, block with options, answer, resume and complete. The planner agent creates it, the worker agent claims it and asks which way to go, a person (`maya`) answers, and the worker claims it again and finishes. This output was produced by running those steps against a local TeamKit server with an empty database, and reading `GET /v1/events?thread=<id>&after=0`. Each event has been checked against the `@ag-ui/core` 1.0.2 schemas. Each line below is one AG-UI event, and each comment line is the board event they came from.

```jsonc
// cursor 1 · kind task.created · by planner
{"name":"teamkit.task.created","type":"CUSTOM","value":{"room":"support","brief":"Draft the reply to the refund request","needs":[],"labels":{"priority":"high"},"target":null,"taskId":"th_1e753d17636d0a6d"}}
{"role":"user","type":"TEXT_MESSAGE_START","metadata":{"teamkit":{"actorId":"ac_28c02d4ebc845ce2","actorKind":"agent","actorName":"planner"}},"messageId":"msg_0f3520845d0fe21e"}
{"type":"TEXT_MESSAGE_CONTENT","delta":"Draft the reply to the refund request","metadata":{"teamkit":{"actorId":"ac_28c02d4ebc845ce2","actorKind":"agent","actorName":"planner"}},"messageId":"msg_0f3520845d0fe21e"}
{"type":"TEXT_MESSAGE_END","metadata":{"teamkit":{"actorId":"ac_28c02d4ebc845ce2","actorKind":"agent","actorName":"planner"}},"messageId":"msg_0f3520845d0fe21e"}

// cursor 2 · kind task.claimed · by worker
{"name":"teamkit.task.claimed","type":"CUSTOM","value":{"actor":{"id":"ac_58c65f76c3339603","kind":"agent","name":"worker"},"claimId":"cl_e46b2515fa8d6358"}}
{"type":"RUN_STARTED","runId":"cl_e46b2515fa8d6358","metadata":{"teamkit":{"claimId":"cl_e46b2515fa8d6358"}},"threadId":"th_1e753d17636d0a6d"}

// cursor 3 · kind task.blocked · by worker
{"role":"assistant","type":"TEXT_MESSAGE_START","metadata":{"teamkit":{"actorId":"ac_58c65f76c3339603","actorKind":"agent","actorName":"worker"}},"messageId":"msg_3c8b904c5e326573"}
{"type":"TEXT_MESSAGE_CONTENT","delta":"Question (needs_input): Refund in full or offer store credit? [options: full refund|store credit]","metadata":{"teamkit":{"actorId":"ac_58c65f76c3339603","actorKind":"agent","actorName":"worker"}},"messageId":"msg_3c8b904c5e326573"}
{"type":"TEXT_MESSAGE_END","metadata":{"teamkit":{"actorId":"ac_58c65f76c3339603","actorKind":"agent","actorName":"worker"}},"messageId":"msg_3c8b904c5e326573"}
{"type":"RUN_FINISHED","runId":"cl_e46b2515fa8d6358","outcome":{"type":"interrupt","interrupts":[{"id":"in_3d88b24b7854fcc4","reason":"needs_input","message":"Refund in full or offer store credit?","responseSchema":{"type":"object","required":["choice"],"properties":{"choice":{"enum":["full refund","store credit"],"type":"string"}}}}]},"threadId":"th_1e753d17636d0a6d"}

// cursor 4 · kind task.answered · by maya
{"name":"teamkit.interrupt.answered","type":"CUSTOM","value":{"by":{"id":"ac_563fdcacabca197c","kind":"person","name":"maya"},"payload":{"text":"Customer has been with us for years.","choice":"store credit"},"interruptId":"in_3d88b24b7854fcc4"}}
{"role":"user","type":"TEXT_MESSAGE_START","metadata":{"teamkit":{"actorId":"ac_563fdcacabca197c","actorKind":"person","actorName":"maya"}},"messageId":"msg_45e2fb2860251a9d"}
{"type":"TEXT_MESSAGE_CONTENT","delta":"Customer has been with us for years.","metadata":{"teamkit":{"actorId":"ac_563fdcacabca197c","actorKind":"person","actorName":"maya"}},"messageId":"msg_45e2fb2860251a9d"}
{"type":"TEXT_MESSAGE_END","metadata":{"teamkit":{"actorId":"ac_563fdcacabca197c","actorKind":"person","actorName":"maya"}},"messageId":"msg_45e2fb2860251a9d"}

// cursor 5 · kind task.claimed · by worker
{"name":"teamkit.task.claimed","type":"CUSTOM","value":{"actor":{"id":"ac_58c65f76c3339603","kind":"agent","name":"worker"},"claimId":"cl_df9d798804129848"}}
{"type":"RUN_STARTED","runId":"cl_df9d798804129848","metadata":{"teamkit":{"claimId":"cl_df9d798804129848"}},"threadId":"th_1e753d17636d0a6d"}

// cursor 6 · kind task.completed · by worker
{"type":"RUN_FINISHED","runId":"cl_df9d798804129848","result":"Reply sent with a store credit offer.","outcome":{"type":"success"},"threadId":"th_1e753d17636d0a6d"}
```

Things to notice:

- The task has two runs, one per claim. The first ends in an interrupt (cursor 3) and the second in success (cursor 6). Their ids are the two `claimId`s.
- The answer (cursor 4) is a `CUSTOM` event plus the person's message. It does not start a run. The second claim starts one, and the claim response carries the resume: `[{ "interruptId": "in_3d88b24b7854fcc4", "status": "resolved", "payload": { "text": "Customer has been with us for years.", "choice": "store credit" } }]`. Hand that to the agent as `resume` on its next AG-UI run.
- The brief at cursor 1 and the answer at cursor 4 are `user` messages. The question at cursor 3 is an `assistant` message from the worker.
