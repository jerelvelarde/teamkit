import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardError, PRESENCE_ON_MS, type Alert, type BlockKind, type ChangeEntry, type TaskBlock } from "@copilotkit/teamkit-protocol";
import {
  agentsOn,
  alertAsPerson,
  decideAsPerson,
  entityIdOf,
  handoffTarget,
  isNotAnswererError,
  loadAlert,
  loadChange,
  loadDecision,
  waitsOn,
} from "../src/slack/coordination.js";
import { answer, block } from "../src/store/blocks.js";
import { claimTask } from "../src/store/claims.js";
import { listEvents } from "../src/store/events.js";
import { createTask } from "../src/store/tasks.js";
import { api, seedBilling } from "./helpers/billing.js";
import { withTestDb } from "./helpers/db.js";
import { startTestServer } from "./helpers/server.js";

test("waitsOn: named approvers, else room approvers for an approval, else anyone", () => {
  const b = (kind: BlockKind, approvers: string[] | null): TaskBlock => ({
    interruptId: "int_1", kind, question: "Approve the cutover write to billing-prod?",
    options: ["approve", "reject"], blockedBy: { id: "ac_1", name: "ben-agent", kind: "agent" }, approvers,
  });
  assert.deepEqual(waitsOn(b("awaiting_approval", ["sam"]), ["ana", "sam"]), ["sam"]);
  assert.deepEqual(waitsOn(b("awaiting_approval", null), ["sam"]), ["sam"]);
  assert.equal(waitsOn(b("awaiting_approval", null), null), null);
  assert.equal(waitsOn(b("awaiting_approval", []), []), null);
  assert.equal(waitsOn(b("needs_input", null), ["sam"]), null);
  assert.deepEqual(waitsOn(b("needs_input", ["ana"]), null), ["ana"]);
});

test("a person's decision and alert load back by id from their events", async () => {
  await withTestDb(async (db) => {
    const b = await seedBilling(db, { channels: false, linkSlack: false });
    const d = await decideAsPerson(db, b.ana, "billing-migration", "Freeze writes to the old invoices table from 18:00 UTC.");
    assert.equal(d.decidedBy.name, "ana");
    const [de] = (await listEvents(db, { kinds: ["decision.posted"] })).events;
    assert.equal(entityIdOf(de!), d.id);
    assert.deepEqual(await loadDecision(db, d.id), d);
    const a = await alertAsPerson(db, b.sam, "billing-prod", "Invoice totals differ between the old and new database.");
    assert.equal(a.level, "confirmed");
    assert.equal(a.confirmedBy?.name, "sam");
    const ae = (await listEvents(db, { kinds: ["alert.raised", "alert.confirmed"] })).events;
    assert.ok(ae.length >= 1 && ae.every((e) => entityIdOf(e) === a.id));
    assert.deepEqual(await loadAlert(db, a.id), a);
    assert.equal(await loadDecision(db, "dec_missing"), null);
  });
});

test("an agent's alert, handoff and change are readable through the seam", async () => {
  const s = await startTestServer();
  try {
    const b = await seedBilling(s.db, { channels: false, linkSlack: false });
    const { alert } = await api<{ alert: Alert }>(s.url, b.benAgent.token, "/v1/alerts", { room: "billing-migration", text: "Row counts for invoices differ by 12." });
    assert.equal((await loadAlert(s.db, alert.id))?.level, "suspected");
    const t = await createTask(s.db, b.anaAgent, { room: "billing-migration", brief: "Copy the invoices table to the new database" });
    await claimTask(s.db, b.anaAgent, t.id); // a handoff is made by the agent that holds the task
    await api(s.url, b.anaAgent.token, `/v1/tasks/${t.id}/handoff`, { to: "ben-agent" });
    const [h] = (await listEvents(s.db, { kinds: ["task.handed_off"] })).events;
    assert.equal(handoffTarget(h!), "ben-agent");
    const { change } = await api<{ change: ChangeEntry }>(s.url, b.benAgent.token, "/v1/changes", {
      room: "billing-migration", threadId: t.id, what: "Switched invoice writes to the new database",
      where: "billing-prod", undo: "Point invoice writes back to the old database",
    });
    const [ce] = (await listEvents(s.db, { kinds: ["change.logged"] })).events;
    assert.equal(entityIdOf(ce!), change.id);
    assert.equal((await loadChange(s.db, change.id))?.threadId, t.id);
    assert.equal(entityIdOf(h!), null);
  } finally {
    await s.stop();
  }
});

test("agentsOn counts live sessions watching the room and drops stale ones", async () => {
  const s = await startTestServer();
  try {
    const b = await seedBilling(s.db, { channels: false, linkSlack: false });
    await api(s.url, b.benAgent.token, "/v1/presence", { watching: ["billing-migration"], status: "copying invoices" });
    await api(s.url, b.samAgent.token, "/v1/presence", { watching: ["billing-prod"] });
    assert.deepEqual(await agentsOn(s.db, "billing-migration", Date.now()), [{ name: "ben-agent", sessions: 1 }]);
    assert.deepEqual(await agentsOn(s.db, "billing-migration", Date.now() + PRESENCE_ON_MS + 1000), []);
  } finally {
    await s.stop();
  }
});

test("a refusal for someone the ask does not wait on is recognised", async () => {
  await withTestDb(async (db) => {
    const b = await seedBilling(db, { channels: false, linkSlack: false });
    const t = await createTask(db, b.benAgent, { room: "billing-prod", brief: "Enable writes on the new invoices table" });
    const c = await claimTask(db, b.benAgent, t.id);
    await block(db, b.benAgent, t.id, c.claimId, { question: "Approve the cutover write to billing-prod?", kind: "awaiting_approval", options: ["approve", "reject"], approvers: ["sam"] });
    const refused = await answer(db, b.ben, t.id, { choice: "approve" }).then(() => null, (e: unknown) => e);
    assert.ok(isNotAnswererError(refused));
    assert.equal(isNotAnswererError(new BoardError("invalid_state", "already answered")), false);
  });
});
