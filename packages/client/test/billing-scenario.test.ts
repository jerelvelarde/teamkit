import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../../../apps/server/test/helpers/server.js";
import { assertAguiValid } from "../../../apps/server/test/helpers/agui.js";
import { BRIEF, PROD_APPROVAL, billingTeam, sessionFetch } from "../../../apps/server/test/helpers/team.js";
import { createClient, type TeamkitError } from "../src/client.js";

test("two agents and one approver run the billing migration through the client", async () => {
  const srv = await startTestServer();
  try {
    const t = await billingTeam(srv.db);
    const ana = createClient({ url: srv.url, token: t.anaAgent.token });
    const ben = createClient({ url: srv.url, token: t.benAgent.token });
    const sam = createClient({ url: srv.url, fetch: sessionFetch(t.sam.session) });
    const benPerson = createClient({ url: srv.url, fetch: sessionFetch(t.ben.session) });

    const task = await ana.createTask({ room: "billing-prod", brief: BRIEF });
    await ana.handoff(task.id, "ben-agent");
    assert.deepEqual((await ben.pending()).handoffs.map((x) => x.id), [task.id]);
    const claim = (await ben.claimNext("billing-prod"))!;
    assert.equal(claim.task.id, task.id);
    await ben.block(task.id, claim.claimId, { ...PROD_APPROVAL, approvers: ["sam"] });
    assert.deepEqual((await sam.pending()).asks.map((x) => x.id), [task.id]);
    await assert.rejects(benPerson.answer(task.id, { choice: "approve" }),
      (e) => (e as TeamkitError).code === "approval_requires_person");
    await sam.answer(task.id, { choice: "approve" });
    assert.deepEqual((await ben.pending()).answered.map((x) => x.id), [task.id]);
    const again = await ben.claim(task.id);
    await ben.logChange({ room: "billing-prod", threadId: task.id, what: "Backfilled invoices_v2 from invoices_v1",
      where: "billing-prod database", undo: "truncate invoices_v2", undoWhen: "if row counts differ" });
    await ben.complete(task.id, again.claimId, "backfilled");

    const d = await sam.postDecision({ room: "billing-prod", text: "Freeze writes to invoices_v1 from 14:00 UTC" });
    await ana.ackDecision(d.id);
    await ben.ackDecision(d.id);
    assert.equal((await sam.decisions("billing-prod"))[0]!.acks.length, 2);

    const rc = await createClient({ url: srv.url, fetch: sessionFetch(t.ana.session) }).startRollCall("billing-prod");
    await ben.heartbeat({ watching: ["billing-prod"], status: "idle" });
    await ben.answerRollCall(rc.id, "on: watching billing-prod");
    assert.deepEqual((await sam.presence("billing-prod")).map((p) => p.actor.name), ["ben-agent"]);

    const alert = await ben.raiseAlert({ room: "billing-prod", text: "invoices_v2 row count is 0.5% below invoices_v1" });
    assert.equal((await sam.confirmAlert(alert.id)).level, "confirmed");
    assert.deepEqual((await sam.alerts("billing-prod", { open: true })).map((a) => a.id), [alert.id]);
    const resolved = await sam.resolveAlert(alert.id);
    assert.deepEqual([resolved.resolvedBy?.name, resolved.resolvedSource?.name], ["sam", "sam"]);
    assert.deepEqual(await sam.alerts("billing-prod", { open: true }), []);

    const kinds = (await sam.events({ thread: task.id })).events.map((e) => e.kind);
    assert.deepEqual(kinds.filter((k) => k !== "message.posted"), ["task.created", "task.handed_off", "task.claimed",
      "task.blocked", "task.answered", "task.claimed", "change.logged", "task.completed"]);
    for (const e of (await sam.events({ room: "billing-prod" })).events) assertAguiValid(e.agui);
  } finally {
    await srv.stop();
  }
});
