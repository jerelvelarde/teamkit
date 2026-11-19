import { test } from "node:test";
import assert from "node:assert/strict";
import { RunFinishedEventSchema } from "@ag-ui/core/schemas";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { assertAguiValid } from "./helpers/agui.js";
import { createTask } from "../src/store/tasks.js";
import { claimTask } from "../src/store/claims.js";
import { answer, block } from "../src/store/blocks.js";
import { setRoom } from "../src/store/rooms.js";
import { listEvents } from "../src/store/events.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

let seq = 0;
async function blockedTask(db: Parameters<typeof agentAuth>[0], kind: "needs_input" | "awaiting_approval", options?: string[]) {
  const bot = await agentAuth(db, `bot${seq++}`);
  const t = await createTask(db, bot, { room: "build", brief: "x" });
  const c = await claimTask(db, bot, t.id);
  const blocked = await block(db, bot, t.id, c.claimId, { question: "ok?", kind, options });
  return { bot, t, c, blocked };
}

test("block clears the claim and logs a valid interrupt with the choice enum", async () => {
  await withTestDb(async (db) => {
    const { t, c, blocked } = await blockedTask(db, "needs_input", ["a", "b"]);
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.claim, null);
    assert.equal(blocked.block!.question, "ok?");
    assert.deepEqual(blocked.block!.options, ["a", "b"]);
    const { events } = await listEvents(db, { kinds: ["task.blocked"] });
    assert.equal(events.length, 1);
    assertAguiValid(events[0]!.agui);
    const fin = RunFinishedEventSchema.parse(events[0]!.agui[0]) as any;
    assert.equal(fin.runId, c.claimId);
    assert.equal(fin.threadId, t.id);
    assert.deepEqual(fin.outcome.interrupts[0].responseSchema.properties.choice.enum, ["a", "b"]);
  });
});

test("block validates kind, question and options", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const t = await createTask(db, bot, { room: "build", brief: "x" });
    const c = await claimTask(db, bot, t.id);
    const bad = [
      { question: "q", kind: "nope" as never },
      { question: "", kind: "needs_input" as const },
      { question: "q", kind: "needs_input" as const, options: [] },
      { question: "q", kind: "needs_input" as const, options: ["a", "a"] },
      { question: "q", kind: "needs_input" as const, options: [""] },
      { question: "q", kind: "needs_input" as const, options: Array.from({ length: 21 }, (_, i) => `o${i}`) },
    ];
    for (const b of bad) await assert.rejects(block(db, bot, t.id, c.claimId, b), code("invalid_input"));
  });
});

test("an agent with post answers needs_input: ready with pending_resume", async () => {
  await withTestDb(async (db) => {
    const { t } = await blockedTask(db, "needs_input", ["a", "b"]);
    const helper = await agentAuth(db, "helper", [{ room: "*", perms: ["read", "post"] }]);
    const r = await answer(db, helper, t.id, { choice: "b" });
    assert.equal(r.state, "ready");
    assert.equal(r.block, null);
    assert.equal(r.pendingResume![0]!.status, "resolved");
    assert.deepEqual(r.pendingResume![0]!.payload, { choice: "b" });
    const { events } = await listEvents(db, { kinds: ["task.answered"] });
    assert.equal(events.length, 1);
    assertAguiValid(events[0]!.agui);
    const noPost = await agentAuth(db, "ro", [{ room: "*", perms: ["read"] }]);
    const t2 = await blockedTask(db, "needs_input");
    await assert.rejects(answer(db, noPost, t2.t.id, { text: "hi" }), code("forbidden"));
  });
});

test("an agent token answering awaiting_approval is refused", async () => {
  await withTestDb(async (db) => {
    const { t, bot } = await blockedTask(db, "awaiting_approval");
    await assert.rejects(answer(db, bot, t.id, { text: "yes" }), code("approval_requires_person"));
    // A person arriving over a token is refused too.
    const p = await personAuth(db, "pat");
    await assert.rejects(answer(db, { ...p, via: "token" }, t.id, { text: "yes" }), code("approval_requires_person"));
    const { events } = await listEvents(db, { kinds: ["task.answered"] });
    assert.equal(events.length, 0);
  });
});

test("approvers: a person outside the list is refused, a listed one answers", async () => {
  await withTestDb(async (db) => {
    const { t } = await blockedTask(db, "awaiting_approval");
    await setRoom(db, "build", { approvers: ["ada"] });
    const eve = await personAuth(db, "eve");
    await assert.rejects(answer(db, eve, t.id, { text: "yes" }), code("approval_requires_person"));
    const ada = await personAuth(db, "ada");
    const r = await answer(db, ada, t.id, { text: "approved" });
    assert.equal(r.state, "ready");
    const { events } = await listEvents(db, { kinds: ["task.answered"] });
    assertAguiValid(events[0]!.agui);
  });
});

test("approvers null: any session member answers", async () => {
  await withTestDb(async (db) => {
    const { t } = await blockedTask(db, "awaiting_approval");
    const eve = await personAuth(db, "eve");
    assert.equal((await answer(db, eve, t.id, { text: "yes" })).state, "ready");
  });
});

test("a choice outside the options, or with no options, is invalid_input", async () => {
  await withTestDb(async (db) => {
    const a = await blockedTask(db, "needs_input", ["a", "b"]);
    const p = await personAuth(db, "pat");
    await assert.rejects(answer(db, p, a.t.id, { choice: "c" }), code("invalid_input"));
    await assert.rejects(answer(db, p, a.t.id, {}), code("invalid_input"));
    const b = await blockedTask(db, "needs_input");
    await assert.rejects(answer(db, p, b.t.id, { choice: "a" }), code("invalid_input"));
  });
});

test("answering a ready or missing task is refused", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const t = await createTask(db, bot, { room: "build", brief: "x" });
    await assert.rejects(answer(db, bot, t.id, { text: "hi" }), code("invalid_state"));
    await assert.rejects(answer(db, bot, "th_nope", { text: "hi" }), code("not_found"));
  });
});

test("blocking with a stale claim is claim_lost", async () => {
  await withTestDb(async (db) => {
    const a = await agentAuth(db, "a");
    const b = await agentAuth(db, "b");
    const t = await createTask(db, a, { room: "build", brief: "x" });
    const first = await claimTask(db, a, t.id);
    await db`update tasks set state='ready', claim_id=null, claimed_by=null, lease_expires_at=null where thread_id=${t.id}`;
    await claimTask(db, b, t.id);
    await assert.rejects(block(db, a, t.id, first.claimId, { question: "q", kind: "needs_input" }), code("claim_lost"));
  });
});
