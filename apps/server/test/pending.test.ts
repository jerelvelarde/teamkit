import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pending } from "@copilotkit/teamkit-protocol";
import type { Db } from "../src/db/pool.js";
import { withTestDb } from "./helpers/db.js";
import { FREEZE, PROD_APPROVAL, billingTeam, blockedTask } from "./helpers/team.js";
import { pendingFor } from "../src/store/pending.js";
import { answer } from "../src/store/blocks.js";
import { claimTask } from "../src/store/claims.js";
import { ackDecision, postDecision } from "../src/store/decisions.js";
import { handoff } from "../src/store/handoff.js";
import { answerRollCall, startRollCall } from "../src/store/rollcalls.js";
import { createTask } from "../src/store/tasks.js";

async function busyDay(db: Db) {
  const team = await billingTeam(db);
  const { ana, sam, anaAgent, benAgent } = team;
  const handed = await createTask(db, anaAgent.auth, { room: "billing-migration", brief: "Write the cutover runbook" });
  await handoff(db, anaAgent.auth, handed.id, "ben-agent");
  const asked = await blockedTask(db, benAgent, "billing-prod", { ...PROD_APPROVAL, approvers: ["sam"] });
  await answer(db, sam.auth, asked.id, { choice: "approve" });
  const decision = await postDecision(db, sam.auth, { room: "billing-migration", text: FREEZE });
  const rollCall = await startRollCall(db, ana.auth, "billing-migration");
  return { ...team, handed, asked, decision, rollCall };
}

const ids = (p: Pending) => ({
  handoffs: p.handoffs.map((t) => t.id),
  answered: p.answered.map((t) => t.id),
  decisions: p.decisions.map((d) => d.id),
  rollCalls: p.rollCalls.map((r) => r.id),
  asks: p.asks.map((t) => t.id),
});
const NONE = { handoffs: [], answered: [], decisions: [], rollCalls: [], asks: [] };

test("ben-agent's pending lists its handoff, its answered ask, an unacked decision and an open roll call", async () => {
  await withTestDb(async (db) => {
    const d = await busyDay(db);
    assert.deepEqual(ids(await pendingFor(db, d.benAgent.auth)),
      { handoffs: [d.handed.id], answered: [d.asked.id], decisions: [d.decision.id], rollCalls: [d.rollCall.id], asks: [] });
  });
});

test("acking, answering and claiming empty ben-agent's pending", async () => {
  await withTestDb(async (db) => {
    const d = await busyDay(db);
    await ackDecision(db, d.benAgent.auth, d.decision.id);
    await answerRollCall(db, d.benAgent.auth, d.rollCall.id, "on");
    await claimTask(db, d.benAgent.auth, d.handed.id);
    await claimTask(db, d.benAgent.auth, d.asked.id);
    assert.deepEqual(ids(await pendingFor(db, d.benAgent.auth)), NONE);
  });
});

test("what a caller made itself is not pending for it", async () => {
  await withTestDb(async (db) => {
    const { anaAgent, benAgent } = await billingTeam(db);
    const dec = await postDecision(db, anaAgent.auth, { room: "billing-migration", text: FREEZE, decidedBy: "ana" });
    const rc = await startRollCall(db, anaAgent.auth, "billing-migration");
    const mine = await pendingFor(db, anaAgent.auth);
    assert.deepEqual([ids(mine).decisions, ids(mine).rollCalls], [[], []]);
    const bens = await pendingFor(db, benAgent.auth);
    assert.deepEqual([ids(bens).decisions, ids(bens).rollCalls], [[dec.id], [rc.id]]);
  });
});

test("a roll call older than an hour and a lapsed hold leave pending", async () => {
  await withTestDb(async (db) => {
    const d = await busyDay(db);
    await db`update rollcalls set created_at = now() - interval '61 minutes'`;
    await db`update tasks set reserved_until = now() - interval '1 second' where reserved_until is not null`;
    const p = ids(await pendingFor(db, d.benAgent.auth));
    assert.deepEqual([p.rollCalls, p.handoffs, p.answered], [[], [], []]);
  });
});

test("each person's asks follow the answer rule, without the admin override", async () => {
  await withTestDb(async (db) => {
    const { ana, ben, sam, benAgent } = await billingTeam(db);
    const input = { kind: "needs_input" as const, question: "Which column holds the currency?" };
    const a = await blockedTask(db, benAgent, "billing-prod", { ...PROD_APPROVAL, approvers: ["sam"] });
    const b = await blockedTask(db, benAgent, "billing-prod", PROD_APPROVAL);
    const c = await blockedTask(db, benAgent, "billing-migration", { ...PROD_APPROVAL, approvers: ["ben"] });
    const d = await blockedTask(db, benAgent, "billing-migration", input);
    const e = await blockedTask(db, benAgent, "billing-prod", { ...input, approvers: ["ben"] });
    const f = await blockedTask(db, benAgent, "billing-migration", PROD_APPROVAL);
    await postDecision(db, sam.auth, { room: "billing-migration", text: FREEZE });
    await startRollCall(db, sam.auth, "billing-migration");
    const sams = await pendingFor(db, sam.auth);
    assert.deepEqual(ids(sams).asks, [a.id, b.id, d.id, f.id]);
    assert.deepEqual(ids(await pendingFor(db, ben.auth)).asks, [c.id, d.id, e.id, f.id]);
    const anas = await pendingFor(db, ana.auth);
    assert.deepEqual(ids(anas).asks, [d.id, f.id]);
    assert.deepEqual([ids(anas).decisions, ids(anas).rollCalls], [[], []]);
    assert.deepEqual(ids(await pendingFor(db, benAgent.auth)).asks, []);
  });
});

test("an agent's pending shows only rooms it can read", async () => {
  await withTestDb(async (db) => {
    const { sam, benAgent } = await billingTeam(db);
    const dec = await postDecision(db, sam.auth, { room: "billing-prod", text: FREEZE });
    assert.deepEqual(ids(await pendingFor(db, benAgent.auth)).decisions, [dec.id]);
    await db`delete from grants where actor_id = ${benAgent.actor.id} and room_pattern = 'billing-prod'`;
    assert.deepEqual(ids(await pendingFor(db, benAgent.auth)).decisions, []);
  });
});

test("decisions are capped at 20, newest first", async () => {
  await withTestDb(async (db) => {
    const { sam, benAgent } = await billingTeam(db);
    const posted = [];
    for (let i = 0; i < 22; i++) posted.push(await postDecision(db, sam.auth, { room: "billing-migration", text: `${FREEZE} (${i})` }));
    assert.deepEqual(ids(await pendingFor(db, benAgent.auth)).decisions, posted.reverse().slice(0, 20).map((d) => d.id));
  });
});
