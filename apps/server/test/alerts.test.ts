import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { assertAguiValid } from "./helpers/agui.js";
import { billingTeam } from "./helpers/team.js";
import { confirmAlert, listAlerts, loadAlerts, raiseAlert, resolveAlert } from "../src/store/alerts.js";
import { listEvents } from "../src/store/events.js";
import { getThread } from "../src/store/threads.js";

const code = (c: string, msg?: RegExp) => (e: unknown) =>
  (e as { code?: string }).code === c && (msg === undefined || msg.test((e as Error).message));
const valueOf = (x: unknown) => (x as { value: unknown }).value;
const said = async (db: Parameters<typeof getThread>[0], auth: Parameters<typeof getThread>[1], threadId: string) =>
  (await getThread(db, auth, threadId)).messages.map((m) => [m.role, (m as { name?: string }).name, (m as { content?: string }).content]);

const GAP = "invoices_v2 row count is 0.5% below invoices_v1";

test("any agent raises a suspected alert on its own thread", async () => {
  await withTestDb(async (db) => {
    const { benAgent, ben } = await billingTeam(db);
    const a = await raiseAlert(db, benAgent.auth, { room: "billing-prod", text: GAP });
    assert.deepEqual(
      [a.level, a.raisedBy, a.confirmedBy, a.source, a.resolvedBy, a.resolvedSource, a.resolvedAt],
      ["suspected", benAgent.actor, null, null, null, null, null],
    );
    assert.deepEqual(await said(db, ben.auth, a.threadId), [["assistant", "ben-agent", `Alert (suspected): ${GAP}`]]);
    const [e] = (await listEvents(db, { kinds: ["alert.raised"] })).events;
    assert.equal(e!.threadId, a.threadId);
    assert.equal(e!.data.alertId, a.id);
    assertAguiValid(e!.agui);
    assert.deepEqual(valueOf(e!.agui[0]),
      { alertId: a.id, room: "billing-prod", text: GAP, level: "suspected", raisedBy: benAgent.actor });
    assert.deepEqual(await loadAlerts(db, [a.id, "alr_0000000000000000"]), [a]);
  });
});

test("sam confirms: confirmed by sam, sourced from sam", async () => {
  await withTestDb(async (db) => {
    const { sam, benAgent } = await billingTeam(db);
    const a = await raiseAlert(db, benAgent.auth, { room: "billing-prod", text: GAP });
    const c = await confirmAlert(db, sam.auth, a.id, {});
    assert.deepEqual([c.level, c.confirmedBy, c.source], ["confirmed", sam.actor, sam.actor]);
    const [e] = (await listEvents(db, { kinds: ["alert.confirmed"] })).events;
    assert.equal(e!.threadId, a.threadId);
    assert.deepEqual(e!.data, { alertId: a.id, level: "confirmed", source: sam.actor });
    assert.deepEqual(valueOf(e!.agui[0]), { alertId: a.id, by: sam.actor, source: sam.actor });
    assertAguiValid(e!.agui);
  });
});

test("an agent confirms only by naming its owner as the source", async () => {
  await withTestDb(async (db) => {
    const { ben, benAgent, samAgent } = await billingTeam(db);
    const a = await raiseAlert(db, benAgent.auth, { room: "billing-prod", text: GAP });
    await assert.rejects(confirmAlert(db, benAgent.auth, a.id, {}), code("invalid_input"));
    await assert.rejects(confirmAlert(db, benAgent.auth, a.id, { source: "sam" }), code("forbidden"));
    const c = await confirmAlert(db, benAgent.auth, a.id, { source: "ben" });
    assert.deepEqual([c.level, c.confirmedBy, c.source], ["confirmed", benAgent.actor, ben.actor]);
    await db`update actors set owner_id = null where id = ${samAgent.actor.id}`;
    const fresh = await raiseAlert(db, benAgent.auth, { room: "billing-prod", text: GAP });
    await assert.rejects(confirmAlert(db, samAgent.auth, fresh.id, { source: "sam" }), code("forbidden", /has no owner/));
  });
});

test("a person cannot name someone else as the source", async () => {
  await withTestDb(async (db) => {
    const { ben, benAgent } = await billingTeam(db);
    const a = await raiseAlert(db, benAgent.auth, { room: "billing-prod", text: GAP });
    await assert.rejects(confirmAlert(db, ben.auth, a.id, { source: "sam" }), code("invalid_input"));
  });
});

test("a confirmed alert cannot be confirmed again; an unknown one is not_found", async () => {
  await withTestDb(async (db) => {
    const { sam, benAgent } = await billingTeam(db);
    const a = await raiseAlert(db, benAgent.auth, { room: "billing-prod", text: GAP });
    await confirmAlert(db, sam.auth, a.id, {});
    await assert.rejects(confirmAlert(db, sam.auth, a.id, {}), code("invalid_state", /already confirmed by sam/));
    await assert.rejects(confirmAlert(db, sam.auth, "alr_0000000000000000", {}), code("not_found"));
  });
});

test("sam resolves a confirmed alert: resolved by sam, logged, and closed for good", async () => {
  await withTestDb(async (db) => {
    const { sam, benAgent } = await billingTeam(db);
    const a = await raiseAlert(db, benAgent.auth, { room: "billing-prod", text: GAP });
    await confirmAlert(db, sam.auth, a.id, {});
    const r = await resolveAlert(db, sam.auth, a.id, {});
    assert.deepEqual([r.resolvedBy, r.resolvedSource, r.level], [sam.actor, sam.actor, "confirmed"]);
    assert.ok(Math.abs(Date.parse(r.resolvedAt!) - Date.now()) < 5_000);
    const [e] = (await listEvents(db, { kinds: ["alert.resolved"] })).events;
    assert.equal(e!.threadId, a.threadId);
    assert.deepEqual(e!.data, { alertId: a.id, source: sam.actor });
    assert.deepEqual(valueOf(e!.agui[0]), { alertId: a.id, by: sam.actor, source: sam.actor });
    assertAguiValid(e!.agui);
    await assert.rejects(resolveAlert(db, sam.auth, a.id, {}), code("invalid_state", /already resolved by sam/));
    await assert.rejects(confirmAlert(db, sam.auth, a.id, {}), code("invalid_state", /resolved by sam/));
  });
});

test("a suspected alert is resolved without being confirmed; an agent resolves only for its owner", async () => {
  await withTestDb(async (db) => {
    const { ben, benAgent } = await billingTeam(db);
    const a = await raiseAlert(db, benAgent.auth, { room: "billing-prod", text: GAP });
    await assert.rejects(resolveAlert(db, benAgent.auth, a.id, {}), code("invalid_input"));
    await assert.rejects(resolveAlert(db, benAgent.auth, a.id, { source: "sam" }), code("forbidden"));
    const r = await resolveAlert(db, benAgent.auth, a.id, { source: "ben" });
    assert.deepEqual([r.level, r.resolvedBy, r.resolvedSource], ["suspected", benAgent.actor, ben.actor]);
    const [e] = (await listEvents(db, { kinds: ["alert.resolved"] })).events;
    assert.deepEqual(e!.data.source, ben.actor);
    assert.deepEqual((await loadAlerts(db, [a.id]))[0]!.resolvedSource, ben.actor);
    const fresh = await raiseAlert(db, benAgent.auth, { room: "billing-prod", text: GAP });
    await assert.rejects(resolveAlert(db, ben.auth, fresh.id, { source: "sam" }), code("invalid_input"));
    await assert.rejects(resolveAlert(db, ben.auth, "alr_0000000000000000", {}), code("not_found"));
  });
});

test("alerts list newest first, open=true leaves out resolved ones, and need read; text is validated", async () => {
  await withTestDb(async (db) => {
    const { sam, benAgent } = await billingTeam(db);
    const a1 = await raiseAlert(db, benAgent.auth, { room: "billing-prod", text: GAP });
    const a2 = await raiseAlert(db, benAgent.auth, { room: "billing-prod", text: GAP });
    assert.deepEqual((await listAlerts(db, sam.auth, "billing-prod")).map((a) => a.id), [a2.id, a1.id]);
    await resolveAlert(db, sam.auth, a2.id, {});
    assert.deepEqual((await listAlerts(db, sam.auth, "billing-prod", { open: true })).map((a) => a.id), [a1.id]);
    assert.deepEqual((await listAlerts(db, sam.auth, "billing-prod")).map((a) => a.id), [a2.id, a1.id]);
    await assert.rejects(raiseAlert(db, benAgent.auth, { room: "billing-prod", text: "" }), code("invalid_input"));
    await assert.rejects(raiseAlert(db, benAgent.auth, { room: "billing-prod", text: "x".repeat(2001) }), code("invalid_input"));
    await db`delete from grants where actor_id = ${benAgent.actor.id} and room_pattern = 'billing-prod'`;
    await assert.rejects(listAlerts(db, benAgent.auth, "billing-prod"), code("forbidden"));
  });
});
