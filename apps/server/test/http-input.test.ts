import { test } from "node:test";
import assert from "node:assert/strict";
import type { Claim, Task } from "@copilotkit/teamkit-protocol";
import { withTestDb } from "./helpers/db.js";
import { agentAuth } from "./helpers/actors.js";
import { createNotifier } from "../src/notifier.js";
import { createApp } from "../src/http/app.js";

type App = ReturnType<typeof createApp>;

// NUL, and lone high and low surrogates. Postgres refuses the first in text and
// jsonb and the others in jsonb; each must be a 400, never a 500.
const DIRTY = ["a\u0000b", "a\uD800b", "a\uDC00b"];

function call(app: App, token: string, path: string, body?: unknown) {
  return app.request(`/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function expectInvalid(res: Response, what: string): Promise<void> {
  assert.equal(res.status, 400, what);
  const j = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(j.error.code, "invalid_input", what);
  assert.doesNotMatch(j.error.message, /SQLSTATE|syntax|encoding|byte sequence/i, what);
}

async function withApp(fn: (app: App, token: string) => Promise<void>): Promise<void> {
  await withTestDb(async (db) => {
    const notifier = await createNotifier(db);
    try {
      const a = await agentAuth(db, "bot");
      await fn(createApp({ db, notifier }), a.token);
    } finally {
      await notifier.close();
    }
  });
}

test("NUL and lone surrogates in body strings are 400 invalid_input", async () => {
  await withApp(async (app, token) => {
    const { threadId } = (await (await call(app, token, "/posts", { room: "build", text: "hi" })).json()) as {
      threadId: string;
    };
    const created = (await (await call(app, token, "/tasks", { room: "build", brief: "x" })).json()) as { task: Task };
    const taskId = created.task.id;
    const claim = (await (await call(app, token, `/tasks/${taskId}/claim`, {})).json()) as Claim;

    for (const d of DIRTY) {
      const cases: [string, unknown][] = [
        ["/posts", { room: "build", text: d }],
        [`/threads/${threadId}/replies`, { text: d }],
        [`/threads/${threadId}/labels`, { key: "k", value: d }],
        ["/tasks", { room: "build", brief: d }],
        ["/tasks", { room: "build", brief: "x", labels: { k: d } }],
        ["/tasks", { room: "build", brief: "x", labels: { [d]: "v" } }],
        ["/tasks", { room: "build", brief: "x", target: d }],
        ["/tasks", { room: "build", brief: "x", needs: [d] }],
        ["/tasks", { room: "build", plan: [{ key: "a", text: d }] }],
        ["/tasks", { room: "build", plan: [{ key: "a", text: "x", labels: { k: d } }] }],
        ["/tasks", { room: "build", plan: [{ key: "a", text: "x", target: d }] }],
        ["/tasks", { room: "build", plan: [{ key: "a", text: "x", needs: [{ id: d }] }] }],
        ["/tasks/claim-next", { room: "build", labels: { k: d } }],
        [`/tasks/${taskId}/renew`, { claimId: d }],
        [`/tasks/${taskId}/complete`, { claimId: claim.claimId, result: d }],
        [`/tasks/${taskId}/fail`, { claimId: claim.claimId, reason: d }],
        [`/tasks/${taskId}/block`, { claimId: claim.claimId, question: d }],
        [`/tasks/${taskId}/block`, { claimId: claim.claimId, question: "q", options: ["ok", d] }],
        [`/tasks/${taskId}/answer`, { text: d }],
        [`/tasks/${taskId}/answer`, { choice: d }],
      ];
      for (const [path, body] of cases) await expectInvalid(await call(app, token, path, body), `${path} ${JSON.stringify(body)}`);
    }
    // Nothing above changed the claimed task.
    const after = (await (await call(app, token, `/tasks?state=all`)).json()) as { tasks: Task[] };
    assert.equal(after.tasks.find((t) => t.id === taskId)?.state, "claimed");
  });
});

test("NUL in path params and query values is 400 invalid_input", async () => {
  await withApp(async (app, token) => {
    const paths: [string, unknown?][] = [
      ["/threads/x%00y"],
      ["/threads/x%00y/replies", { text: "hi" }],
      ["/threads/x%00y/labels", { key: "k", value: "v" }],
      ["/tasks/x%00y/claim", {}],
      ["/tasks/x%00y/renew", { claimId: "c" }],
      ["/tasks/x%00y/release", { claimId: "c" }],
      ["/tasks/x%00y/complete", { claimId: "c" }],
      ["/tasks/x%00y/fail", { claimId: "c", reason: "r" }],
      ["/tasks/x%00y/block", { claimId: "c", question: "q" }],
      ["/tasks/x%00y/answer", { text: "t" }],
      ["/tasks?label=k%3Dv%00w"],
      ["/tasks?label=k%00%3Dv"],
      ["/tasks?room=b%00"],
      ["/events?thread=th_x%00y"],
      ["/events/stream?thread=th_x%00y"],
      ["/room?name=b%00"],
    ];
    for (const [path, body] of paths) await expectInvalid(await call(app, token, path, body), path);
    // Invalid UTF-8 in a URL is never decoded into a lone surrogate.
    const raw = await call(app, token, "/tasks/%ED%A0%80/claim", {});
    assert.ok(raw.status < 500, `status ${raw.status}`);
  });
});
