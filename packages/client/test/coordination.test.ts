import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../../../apps/server/test/helpers/server.js";
import {
  BRIEF,
  FREEZE,
  PROD_APPROVAL,
  billingTeam,
  sessionFetch,
  type TeamAgent,
  type TeamPerson,
} from "../../../apps/server/test/helpers/team.js";
import { createClient, TeamkitError } from "../src/client.js";

async function team() {
  const srv = await startTestServer();
  const t = await billingTeam(srv.db);
  const as = (a: TeamAgent) => createClient({ url: srv.url, token: a.token });
  const person = (p: TeamPerson) => createClient({ url: srv.url, fetch: sessionFetch(p.session) });
  return { srv, t, as, person };
}

test("block sends approvers; a person who is not named gets 403 approval_requires_person", async () => {
  const { srv, t, as, person } = await team();
  try {
    const ben = as(t.benAgent);
    const task = await ben.createTask({ room: "billing-prod", brief: BRIEF });
    const claim = await ben.claim(task.id);
    const blocked = await ben.block(task.id, claim.claimId, { ...PROD_APPROVAL, approvers: ["sam"] });
    assert.deepEqual(blocked.block!.approvers, ["sam"]);
    await assert.rejects(person(t.ben).answer(task.id, { choice: "approve" }),
      (e) => e instanceof TeamkitError && e.code === "approval_requires_person" && e.status === 403);
    assert.equal((await person(t.sam).answer(task.id, { choice: "approve" })).state, "ready");
  } finally {
    await srv.stop();
  }
});

test("handoff returns the held task; handing to a person is 400 invalid_input", async () => {
  const { srv, t, as } = await team();
  try {
    const ana = as(t.anaAgent);
    const task = await ana.createTask({ room: "billing-migration", brief: BRIEF });
    assert.equal((await ana.handoff(task.id, "ben-agent")).reservedFor?.name, "ben-agent");
    const task2 = await ana.createTask({ room: "billing-migration", brief: BRIEF });
    await assert.rejects(ana.handoff(task2.id, "ben"),
      (e) => e instanceof TeamkitError && e.code === "invalid_input" && e.status === 400);
  } finally {
    await srv.stop();
  }
});

test("decisions round-trip through the client, and an agent without decidedBy gets 400", async () => {
  const { srv, t, as } = await team();
  try {
    const d = await as(t.anaAgent).postDecision({ room: "billing-migration", text: FREEZE, decidedBy: "ana" });
    assert.equal(d.decidedBy.name, "ana");
    assert.equal((await as(t.benAgent).ackDecision(d.id)).acks.length, 1);
    assert.equal((await as(t.benAgent).decisions("billing-migration"))[0]!.id, d.id);
    await assert.rejects(as(t.anaAgent).postDecision({ room: "billing-migration", text: FREEZE }),
      (e) => e instanceof TeamkitError && e.code === "invalid_input" && e.status === 400);
  } finally {
    await srv.stop();
  }
});

test("a room with a slash works on ?room= and in the body", async () => {
  const { srv, t, person } = await team();
  try {
    await person(t.sam).postDecision({ room: "billing-migration/backfill", text: FREEZE });
    assert.equal((await person(t.sam).decisions("billing-migration/backfill")).length, 1);
  } finally {
    await srv.stop();
  }
});

test("roll calls round-trip through the client", async () => {
  const { srv, t, as, person } = await team();
  try {
    const r = await person(t.ana).startRollCall("billing-migration");
    assert.equal((await as(t.benAgent).answerRollCall(r.id, "on")).answers[0]!.status, "on");
    assert.equal((await as(t.samAgent).rollCalls("billing-migration"))[0]!.answers.length, 1);
  } finally {
    await srv.stop();
  }
});

test("heartbeat then presence over HTTP", async () => {
  const { srv, t, as, person } = await team();
  try {
    await as(t.benAgent).heartbeat({ watching: ["billing-migration"] });
    assert.equal((await person(t.ana).presence("billing-migration"))[0]!.sessions[0]!.tokenId, t.benAgent.tokenId);
    await assert.rejects(person(t.ben).heartbeat({ watching: [] }),
      (e) => e instanceof TeamkitError && e.code === "forbidden" && e.status === 403);
  } finally {
    await srv.stop();
  }
});

const ADD_COLUMN = { what: "Added column invoices.currency_code", where: "billing-prod database",
  undo: "alter table invoices drop column currency_code", undoWhen: "if the backfill fails" };

test("changes round-trip through the client", async () => {
  const { srv, t, as } = await team();
  try {
    const ben = as(t.benAgent);
    const c = await ben.logChange({ room: "billing-prod", ...ADD_COLUMN });
    assert.equal((await ben.updateChange(c.id, "restored")).status, "restored");
    assert.equal((await ben.changes("billing-prod", { status: "restored" })).length, 1);
    await assert.rejects(ben.updateChange(c.id, "undone" as never),
      (e) => e instanceof TeamkitError && e.code === "invalid_input" && e.status === 400);
  } finally {
    await srv.stop();
  }
});
