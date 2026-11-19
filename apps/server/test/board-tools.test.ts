import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { agentAuth } from "./helpers/actors.js";
import { agentAuthContext } from "../src/dispatch/registry.js";
import { executeBoardTool } from "../src/dispatch/board-tools.js";
import { createTask } from "../src/store/tasks.js";
import { claimTask } from "../src/store/claims.js";
import { block } from "../src/store/blocks.js";
import { getThread } from "../src/store/threads.js";

const call = (name: string, args: unknown) => ({
  id: "c1",
  name,
  args: typeof args === "string" ? args : JSON.stringify(args),
});

async function blocker(db: Parameters<typeof agentAuth>[0], kind: "needs_input" | "awaiting_approval", options?: string[]) {
  const other = await agentAuth(db, `other-${kind === "needs_input" ? "ask" : "approve"}`);
  const t = await createTask(db, other, { room: "build", brief: "y" });
  const c = await claimTask(db, other, t.id);
  await block(db, other, t.id, c.claimId, { question: "ok?", kind, options });
  return t.id;
}

test("board tools run with the agent's permissions", async () => {
  await withTestDb(async (db) => {
    const me = await agentAuth(db, "me", [{ room: "build", perms: ["read", "post", "create"] }]);

    const created = await executeBoardTool(db, me, call("teamkit_create_task", { room: "build", brief: "x" }));
    assert.equal(created.ok, true);
    const { taskId, state } = JSON.parse(created.content);
    assert.match(taskId, /^th_/);
    assert.equal(state, "ready");

    assert.deepEqual(JSON.parse((await executeBoardTool(db, me, call("teamkit_reply", { threadId: taskId, text: "hello" }))).content), { ok: true });
    const read = await executeBoardTool(db, me, call("teamkit_read", { threadId: taskId }));
    assert.equal(read.ok, true);
    const view = JSON.parse(read.content);
    assert.equal(view.thread.room, "build");
    assert.equal(view.task.brief, "x");
    assert.ok(view.messages.some((m: { content: string }) => m.content === "hello"));

    const lab = await executeBoardTool(db, me, call("teamkit_label", { threadId: taskId, key: "p", value: "1" }));
    assert.deepEqual(JSON.parse(lab.content), { ok: true });
    assert.equal((await getThread(db, me, taskId)).thread.labels.p, "1");

    const denied = await executeBoardTool(db, me, call("teamkit_create_task", { room: "secret", brief: "x" }));
    assert.equal(denied.ok, false);
    assert.equal(JSON.parse(denied.content).error.code, "forbidden");
  });
});

test("answer: approvals need a person, questions take a choice", async () => {
  await withTestDb(async (db) => {
    const me = await agentAuth(db, "me", [{ room: "build", perms: ["read", "post", "create"] }]);
    const approval = await blocker(db, "awaiting_approval");
    const r = await executeBoardTool(db, me, call("teamkit_answer", { taskId: approval, text: "yes" }));
    assert.equal(r.ok, false);
    assert.equal(JSON.parse(r.content).error.code, "approval_requires_person");

    const q = await blocker(db, "needs_input", ["pg", "sqlite"]);
    const ok = await executeBoardTool(db, me, call("teamkit_answer", { taskId: q, choice: "pg" }));
    assert.equal(ok.ok, true);
    assert.deepEqual(JSON.parse(ok.content), { taskId: q, state: "ready" });
  });
});

test("the system auth of a registered agent is refused approvals too", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "reg");
    const sys = agentAuthContext({ name: "reg", actor: bot.actor, url: "", headers: {}, rooms: [], enabled: true, createdAt: "" });
    const approval = await blocker(db, "awaiting_approval");
    const r = await executeBoardTool(db, sys, call("teamkit_answer", { taskId: approval, text: "yes" }));
    assert.equal(JSON.parse(r.content).error.code, "approval_requires_person");
  });
});

test("bad input never throws", async () => {
  await withTestDb(async (db) => {
    const me = await agentAuth(db, "me");
    for (const [name, args] of [
      ["teamkit_read", "{oops"],
      ["teamkit_read", "[1]"],
      ["teamkit_reply", { threadId: 5, text: "x" }],
      ["teamkit_create_task", { room: "build", brief: "x", needs: "a" }],
      ["weather", {}],
    ] as const) {
      const r = await executeBoardTool(db, me, call(name, args));
      assert.equal(r.ok, false, name);
      assert.equal(JSON.parse(r.content).error.code, "invalid_input", name);
    }
    assert.match(
      JSON.parse((await executeBoardTool(db, me, call("teamkit_reply", { threadId: 5, text: "x" }))).content).error.message,
      /threadId/,
    );
    assert.equal(JSON.parse((await executeBoardTool(db, me, call("teamkit_read", { threadId: "th_nope" }))).content).error.code, "not_found");
  });
});
