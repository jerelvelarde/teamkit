import { test } from "node:test";
import assert from "node:assert/strict";
import type { Claim, Task } from "@copilotkit/teamkit-protocol";
import { withTestDb } from "./helpers/db.js";
import { agentAuth } from "./helpers/actors.js";
import { createNotifier } from "../src/notifier.js";
import { createApp } from "../src/http/app.js";

type App = ReturnType<typeof createApp>;

async function withApp(fn: (app: App, token: string, db: Parameters<Parameters<typeof withTestDb>[0]>[0]) => Promise<void>): Promise<void> {
  await withTestDb(async (db) => {
    const notifier = await createNotifier(db);
    try {
      const a = await agentAuth(db, "bot");
      await fn(createApp({ db, notifier }), a.token, db);
    } finally {
      await notifier.close();
    }
  });
}

function call(app: App, token: string, path: string, body?: unknown, method?: string) {
  return app.request(`/v1${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function createOne(app: App, token: string, body: Record<string, unknown> = {}): Promise<Task> {
  const res = await call(app, token, "/tasks", { room: "build", brief: "do it", ...body });
  assert.equal(res.status, 201);
  return ((await res.json()) as { task: Task }).task;
}

test("create, claim, reply, complete ends completed", async () => {
  await withApp(async (app, token) => {
    const task = await createOne(app, token);
    assert.equal(task.state, "ready");
    const cl = await call(app, token, `/tasks/${task.id}/claim`, {});
    assert.equal(cl.status, 200);
    const claim = (await cl.json()) as Claim;
    assert.equal(claim.task.id, task.id);
    assert.ok(claim.claimId);
    const rn = await call(app, token, `/tasks/${task.id}/renew`, { claimId: claim.claimId });
    assert.equal(rn.status, 200);
    assert.ok(((await rn.json()) as { leaseExpiresAt: string }).leaseExpiresAt);
    const rp = await call(app, token, `/threads/${task.id}/replies`, { text: "working" });
    assert.equal(rp.status, 201);
    const done = await call(app, token, `/tasks/${task.id}/complete`, { claimId: claim.claimId, result: "ok" });
    assert.equal(done.status, 200);
    const t = ((await done.json()) as { task: Task }).task;
    assert.equal(t.state, "completed");
    assert.equal(t.result, "ok");
  });
});

test("two concurrent claims: one 200, one 409 task_claimed", async () => {
  await withApp(async (app, token) => {
    const task = await createOne(app, token);
    const rs = await Promise.all([
      call(app, token, `/tasks/${task.id}/claim`, {}),
      call(app, token, `/tasks/${task.id}/claim`, {}),
    ]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    const loser = rs.find((r) => r.status === 409)!;
    assert.equal(await errCode(loser), "task_claimed");
  });
});

test("a wrong claimId on complete is 409 claim_lost", async () => {
  await withApp(async (app, token) => {
    const task = await createOne(app, token);
    await call(app, token, `/tasks/${task.id}/claim`, {});
    const res = await call(app, token, `/tasks/${task.id}/complete`, { claimId: "cl_nope" });
    assert.equal(res.status, 409);
    assert.equal(await errCode(res), "claim_lost");
  });
});

test("a plan with a cycle is 400 and creates no tasks", async () => {
  await withApp(async (app, token) => {
    const res = await call(app, token, "/tasks", {
      room: "build",
      plan: [
        { key: "a", text: "A", needs: [{ key: "b" }] },
        { key: "b", text: "B", needs: [{ key: "a" }] },
      ],
    });
    assert.equal(res.status, 400);
    assert.equal(await errCode(res), "invalid_input");
    const list = (await (await call(app, token, "/tasks?state=all")).json()) as { tasks: Task[] };
    assert.equal(list.tasks.length, 0);
    const bad = await call(app, token, "/tasks", { room: "build", plan: "nope" });
    assert.equal(bad.status, 400);
  });
});

test("a valid plan returns tasks keyed by plan key", async () => {
  await withApp(async (app, token) => {
    const res = await call(app, token, "/tasks", {
      room: "build",
      plan: [
        { key: "a", text: "A" },
        { key: "b", text: "B", needs: [{ key: "a" }] },
      ],
    });
    assert.equal(res.status, 201);
    const { tasks } = (await res.json()) as { tasks: Record<string, Task> };
    assert.equal(tasks.a!.state, "ready");
    assert.equal(tasks.b!.state, "waiting");
  });
});

test("GET /tasks filters by label and rejects a bogus state", async () => {
  await withApp(async (app, token) => {
    const w = await createOne(app, token, { brief: "w", labels: { role: "worker" } });
    await createOne(app, token, { brief: "r", labels: { role: "reviewer" } });
    const res = await call(app, token, "/tasks?state=all&label=role=worker");
    assert.equal(res.status, 200);
    const { tasks } = (await res.json()) as { tasks: Task[] };
    assert.deepEqual(tasks.map((t) => t.id), [w.id]);
    const bad = await call(app, token, "/tasks?state=bogus");
    assert.equal(bad.status, 400);
    assert.equal(await errCode(bad), "invalid_input");
  });
});

test("block with options; agent cannot answer an approval but can answer needs_input", async () => {
  await withApp(async (app, token) => {
    const t1 = await createOne(app, token, { brief: "approval" });
    const c1 = (await (await call(app, token, `/tasks/${t1.id}/claim`, {})).json()) as Claim;
    const b1 = await call(app, token, `/tasks/${t1.id}/block`, {
      claimId: c1.claimId,
      question: "ship it?",
      kind: "awaiting_approval",
      options: ["yes", "no"],
    });
    assert.equal(b1.status, 200);
    const blocked = ((await b1.json()) as { task: Task }).task;
    assert.equal(blocked.state, "blocked");
    assert.deepEqual(blocked.block?.options, ["yes", "no"]);
    const denied = await call(app, token, `/tasks/${t1.id}/answer`, { choice: "yes" });
    assert.equal(denied.status, 403);
    assert.equal(await errCode(denied), "approval_requires_person");

    const t2 = await createOne(app, token, { brief: "input" });
    const c2 = (await (await call(app, token, `/tasks/${t2.id}/claim`, {})).json()) as Claim;
    const b2 = await call(app, token, `/tasks/${t2.id}/block`, { claimId: c2.claimId, question: "which?" });
    assert.equal(((await b2.json()) as { task: Task }).task.block?.kind, "needs_input");
    const ans = await call(app, token, `/tasks/${t2.id}/answer`, { text: "this one" });
    assert.equal(ans.status, 200);
    assert.equal(((await ans.json()) as { task: Task }).task.state, "ready");
  });
});
