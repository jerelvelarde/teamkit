import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../../../apps/server/test/helpers/server.js";
import {
  BRIEF,
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
