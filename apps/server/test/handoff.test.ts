import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { assertAguiValid } from "./helpers/agui.js";
import { BRIEF, MIN, billingTeam, blockedTask, heldFor, near } from "./helpers/team.js";
import { claimTask, complete } from "../src/store/claims.js";
import { listEvents } from "../src/store/events.js";
import { handoff } from "../src/store/handoff.js";
import { createTask } from "../src/store/tasks.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

test("ana-agent hands a ready task to ben-agent: held for ben-agent, logged, refused to others", async () => {
  await withTestDb(async (db) => {
    const { anaAgent, benAgent, samAgent } = await billingTeam(db);
    const t = await createTask(db, anaAgent.auth, { room: "billing-migration", brief: BRIEF });
    const h = await handoff(db, anaAgent.auth, t.id, "ben-agent");
    assert.equal(h.state, "ready");
    assert.deepEqual(h.reservedFor, benAgent.actor);
    assert.ok(near(h.reservedUntil, 30 * MIN));
    const [e] = (await listEvents(db, { kinds: ["task.handed_off"] })).events;
    assert.deepEqual(e!.actor, anaAgent.actor);
    assert.deepEqual(e!.data, { taskId: t.id, state: "ready", to: benAgent.actor, reservedUntil: h.reservedUntil, claimId: null });
    assert.deepEqual(e!.agui.map((x) => x.type), ["CUSTOM"]);
    assertAguiValid(e!.agui);
    await assert.rejects(claimTask(db, samAgent.auth, t.id), heldFor("ben-agent"));
    assert.equal((await claimTask(db, benAgent.auth, t.id)).task.id, t.id);
  });
});

test("handing off your own claim ends its run and frees the claim", async () => {
  await withTestDb(async (db) => {
    const { benAgent, samAgent } = await billingTeam(db);
    const t = await createTask(db, benAgent.auth, { room: "billing-migration", brief: BRIEF });
    const c = await claimTask(db, benAgent.auth, t.id);
    const h = await handoff(db, benAgent.auth, t.id, "sam-agent");
    assert.equal(h.claim, null);
    assert.equal(h.state, "ready");
    assert.equal(h.attempts, 0);
    assert.deepEqual(h.reservedFor, samAgent.actor);
    const [e] = (await listEvents(db, { kinds: ["task.handed_off"] })).events;
    assert.deepEqual(e!.agui.map((x) => x.type), ["CUSTOM", "RUN_ERROR"]);
    assert.equal((e!.agui[1] as { code?: string }).code, "teamkit.handed_off");
    assert.equal(e!.data.claimId, c.claimId);
  });
});

test("handoff refuses a person, an unknown name, yourself, and an agent that cannot claim in the room", async () => {
  await withTestDb(async (db) => {
    const { anaAgent, samAgent } = await billingTeam(db);
    const t = await createTask(db, anaAgent.auth, { room: "billing-migration", brief: BRIEF });
    for (const to of ["ben", "nobody", "ana-agent"]) {
      await assert.rejects(handoff(db, anaAgent.auth, t.id, to), code("invalid_input"), to);
    }
    await db`delete from grants where actor_id = ${samAgent.actor.id} and room_pattern = 'billing-prod'`;
    const p = await createTask(db, anaAgent.auth, { room: "billing-prod", brief: BRIEF });
    await assert.rejects(handoff(db, anaAgent.auth, p.id, "sam-agent"), code("invalid_input"));
  });
});

test("handoff refuses someone else's claim, a finished or blocked task, and a caller without claim", async () => {
  await withTestDb(async (db) => {
    const { anaAgent, benAgent } = await billingTeam(db);
    const t1 = await createTask(db, anaAgent.auth, { room: "billing-migration", brief: BRIEF });
    await claimTask(db, benAgent.auth, t1.id);
    await assert.rejects(handoff(db, anaAgent.auth, t1.id, "sam-agent"), code("task_claimed"));
    const t2 = await createTask(db, anaAgent.auth, { room: "billing-migration", brief: BRIEF });
    const c2 = await claimTask(db, anaAgent.auth, t2.id);
    await complete(db, anaAgent.auth, t2.id, c2.claimId, "done");
    await assert.rejects(handoff(db, anaAgent.auth, t2.id, "sam-agent"), code("invalid_state"));
    const t3 = await blockedTask(db, anaAgent, "billing-migration", { kind: "needs_input", question: "Which batch size?" });
    await assert.rejects(handoff(db, anaAgent.auth, t3.id, "sam-agent"), code("invalid_state"));
    const t4 = await createTask(db, anaAgent.auth, { room: "billing-migration", brief: BRIEF });
    await db`update grants set perms = '{read,post}' where actor_id = ${anaAgent.actor.id}`;
    await assert.rejects(handoff(db, anaAgent.auth, t4.id, "sam-agent"), code("forbidden"));
  });
});

test("a held task is re-handed only by its holder or a person", async () => {
  await withTestDb(async (db) => {
    const { anaAgent, benAgent, samAgent, ana } = await billingTeam(db);
    const t = await createTask(db, anaAgent.auth, { room: "billing-migration", brief: BRIEF });
    await handoff(db, anaAgent.auth, t.id, "ben-agent");
    await assert.rejects(handoff(db, samAgent.auth, t.id, "ana-agent"), heldFor("ben-agent"));
    assert.deepEqual((await handoff(db, benAgent.auth, t.id, "sam-agent")).reservedFor, samAgent.actor);
    assert.deepEqual((await handoff(db, ana.auth, t.id, "ana-agent")).reservedFor, anaAgent.actor);
  });
});

test("the handed_off CUSTOM value carries the target as an ActorRef", async () => {
  await withTestDb(async (db) => {
    const { anaAgent, benAgent } = await billingTeam(db);
    const t = await createTask(db, anaAgent.auth, { room: "billing-migration", brief: BRIEF });
    const h = await handoff(db, anaAgent.auth, t.id, "ben-agent");
    const [e] = (await listEvents(db, { kinds: ["task.handed_off"] })).events;
    const ev = e!.agui[0] as { name?: string; value?: unknown };
    assert.equal(ev.name, "teamkit.task.handed_off");
    assert.deepEqual(ev.value, { to: benAgent.actor, reservedUntil: h.reservedUntil, claimId: null });
  });
});
