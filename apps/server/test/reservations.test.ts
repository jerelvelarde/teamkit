import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db/pool.js";
import { withTestDb } from "./helpers/db.js";
import { assertAguiValid } from "./helpers/agui.js";
import { startTestServer } from "./helpers/server.js";
import { MIN, PROD_APPROVAL, billingTeam, blockedTask, heldFor, near } from "./helpers/team.js";
import { answer } from "../src/store/blocks.js";
import { claimNext, claimTask } from "../src/store/claims.js";
import { listEvents } from "../src/store/events.js";
import { lapseReservations } from "../src/store/reservations.js";
import { setRoom } from "../src/store/rooms.js";
import { loadTask } from "../src/store/task-load.js";
import { createTask } from "../src/store/tasks.js";

/** ben-agent's billing-prod approval naming sam, answered by sam. */
async function answeredAsk(db: Db) {
  const team = await billingTeam(db);
  const t = await blockedTask(db, team.benAgent, "billing-prod", { ...PROD_APPROVAL, approvers: ["sam"] });
  const answered = await answer(db, team.sam.auth, t.id, { choice: "approve" });
  return { ...team, t, answered };
}

test("an answered ask is held for the agent that asked, for the room's reservationMinutes", async () => {
  await withTestDb(async (db) => {
    const { benAgent, answered } = await answeredAsk(db);
    assert.deepEqual(answered.reservedFor, benAgent.actor);
    assert.ok(near(answered.reservedUntil, 30 * MIN));
    const [e] = (await listEvents(db, { kinds: ["task.answered"] })).events;
    assert.deepEqual(e!.data.reservedFor, benAgent.actor);
    assert.equal(e!.data.reservedUntil, answered.reservedUntil);
  });
});

test("a held task is refused to others and claimed by its holder, which clears the hold", async () => {
  await withTestDb(async (db) => {
    const { t, anaAgent, ana, benAgent } = await answeredAsk(db);
    await assert.rejects(claimTask(db, anaAgent.auth, t.id), heldFor("ben-agent"));
    await assert.rejects(claimTask(db, ana.auth, t.id), heldFor("ben-agent"));
    assert.equal(await claimNext(db, anaAgent.auth, { room: "billing-prod" }), null);
    await claimTask(db, benAgent.auth, t.id);
    const after = await loadTask(db, t.id);
    assert.equal(after!.reservedFor, null);
    assert.equal(after!.reservedUntil, null);
  });
});

test("claimNext gives the caller its own held task first", async () => {
  await withTestDb(async (db) => {
    const { anaAgent, benAgent, ben } = await billingTeam(db);
    const older = await createTask(db, anaAgent.auth, { room: "billing-migration", brief: "Write the cutover runbook" });
    const newer = await blockedTask(db, benAgent, "billing-migration", { kind: "needs_input", question: "Which batch size?" });
    await answer(db, ben.auth, newer.id, { text: "5000" });
    assert.equal((await claimNext(db, benAgent.auth, { room: "*" }))?.task.id, newer.id);
    assert.equal((await claimNext(db, benAgent.auth, { room: "*" }))?.task.id, older.id);
  });
});

test("the hold length comes from the task's room", async () => {
  await withTestDb(async (db) => {
    const { benAgent, sam } = await billingTeam(db);
    await setRoom(db, "billing-prod", { reservationMinutes: 45 });
    const t = await blockedTask(db, benAgent, "billing-prod", { ...PROD_APPROVAL, approvers: ["sam"] });
    const answered = await answer(db, sam.auth, t.id, { choice: "approve" });
    assert.ok(near(answered.reservedUntil, 45 * MIN));
  });
});

test("lapseReservations frees a lapsed hold and logs task.ready with reason reservation_lapsed", async () => {
  await withTestDb(async (db) => {
    const { t, benAgent, anaAgent } = await answeredAsk(db);
    assert.equal(await lapseReservations(db, new Date()), 0);
    assert.equal(await lapseReservations(db, new Date(Date.now() + 31 * MIN)), 1);
    assert.equal((await loadTask(db, t.id))!.reservedFor, null);
    const ready = (await listEvents(db, { kinds: ["task.ready"] })).events;
    const e = ready[ready.length - 1]!;
    assert.equal(e.actor, null);
    assert.deepEqual(e.data, { taskId: t.id, state: "ready", reason: "reservation_lapsed", reservedFor: benAgent.actor });
    assertAguiValid(e.agui);
    await claimTask(db, anaAgent.auth, t.id);
  });
});

test("a hold past reservedUntil no longer blocks a claim before the reaper runs", async () => {
  await withTestDb(async (db) => {
    const { t, anaAgent } = await answeredAsk(db);
    await db`update tasks set reserved_until = now() - interval '1 second' where thread_id = ${t.id}`;
    await claimTask(db, anaAgent.auth, t.id);
  });
});

test("a claim-next poll waiting on a held task claims it within a second of the hold lapsing", async () => {
  const srv = await startTestServer();
  try {
    const { t, anaAgent } = await answeredAsk(srv.db);
    const t0 = Date.now();
    const waiting = fetch(`${srv.url}/v1/tasks/claim-next`, {
      method: "POST",
      headers: { authorization: `Bearer ${anaAgent.token}`, "content-type": "application/json" },
      body: JSON.stringify({ room: "billing-prod", waitMs: 5000 }),
    }).then((r) => r.json() as Promise<{ task?: { id: string } } | null>);
    await new Promise((r) => setTimeout(r, 200));
    await lapseReservations(srv.db, new Date(Date.now() + 31 * MIN));
    const claim = await waiting;
    assert.equal(claim?.task?.id, t.id);
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  } finally {
    await srv.stop();
  }
});
