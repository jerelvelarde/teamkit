import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { billingTeam } from "./helpers/team.js";
import { getRoomInfo } from "../src/store/rooms.js";
import { authenticateSession } from "../src/store/people.js";

test("billingTeam builds ana, ben and sam with their agents", async () => {
  await withTestDb(async (db) => {
    const t = await billingTeam(db);
    assert.equal(t.ana.auth.role, "admin");
    assert.equal(t.ben.auth.role, "member");
    assert.deepEqual(t.benAgent.actor, { id: t.benAgent.actor.id, name: "ben-agent", kind: "agent" });
    const [o] = await db`select owner_id from actors where name = 'ben-agent'`;
    assert.equal(o!.owner_id, t.ben.actor.id);
    assert.equal(t.benAgent.auth.tokenId, t.benAgent.tokenId);
    assert.deepEqual((await getRoomInfo(db, "billing-prod"))?.approvers, ["sam"]);
    assert.equal((await authenticateSession(db, t.sam.session))?.actor.name, "sam");
  });
});
