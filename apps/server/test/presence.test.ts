import { test } from "node:test";
import assert from "node:assert/strict";
import { newId, newTokenSecret } from "@copilotkit/teamkit-protocol";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import type { Db } from "../src/db/pool.js";
import { withTestDb } from "./helpers/db.js";
import { billingTeam } from "./helpers/team.js";
import { revokeToken } from "../src/store/actors.js";
import { listEvents } from "../src/store/events.js";
import { heartbeat, listPresence, loadPresence } from "../src/store/presence.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

/** A second agent-scope token for the same agent: another install. */
async function mintToken(db: Db, actorId: string): Promise<string> {
  const id = newId("tok");
  await db`insert into tokens (id, actor_id, hash, scope) values (${id}, ${actorId}, ${hashToken(newTokenSecret())}, 'agent')`;
  return id;
}

test("a heartbeat records one session per token and writes no event", async () => {
  await withTestDb(async (db) => {
    const { ana, ben, benAgent } = await billingTeam(db);
    const before = (await listEvents(db, {})).events.length;
    await heartbeat(db, benAgent.auth, { watching: ["billing-migration"], status: "idle" });
    const second = { ...benAgent.auth, tokenId: await mintToken(db, benAgent.actor.id) };
    await heartbeat(db, second, { watching: ["billing-migration", "billing-prod"] });
    const [p, ...rest] = await listPresence(db, ana.auth, "billing-migration");
    assert.equal(rest.length, 0);
    assert.deepEqual([p!.actor, p!.owner], [benAgent.actor, ben.actor]);
    assert.deepEqual(p!.sessions.map((s) => s.tokenId), [second.tokenId, benAgent.tokenId]);
    assert.equal((await listEvents(db, {})).events.length, before);
  });
});

test("a second heartbeat from the same token updates it in place", async () => {
  await withTestDb(async (db) => {
    const { ana, benAgent } = await billingTeam(db);
    await heartbeat(db, benAgent.auth, { watching: ["billing-migration"], status: "idle" });
    const first = (await listPresence(db, ana.auth, "billing-migration"))[0]!.sessions[0]!;
    await new Promise((r) => setTimeout(r, 20));
    await heartbeat(db, benAgent.auth, { watching: ["billing-migration"], status: "working on th_9c1e7b3d5a604f2a" });
    const sessions = (await listPresence(db, ana.auth, "billing-migration"))[0]!.sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.status, "working on th_9c1e7b3d5a604f2a");
    assert.ok(Date.parse(sessions[0]!.lastSeenAt) > Date.parse(first.lastSeenAt));
  });
});

test("presence lists only agents watching the room, patterns included", async () => {
  await withTestDb(async (db) => {
    const { ana, anaAgent, benAgent, samAgent } = await billingTeam(db);
    await heartbeat(db, samAgent.auth, { watching: ["billing-prod"] });
    await heartbeat(db, anaAgent.auth, { watching: ["*"] });
    await heartbeat(db, benAgent.auth, { watching: ["billing-migration/"] });
    const names = async (room: string) => (await listPresence(db, ana.auth, room)).map((p) => p.actor.name);
    assert.deepEqual(await names("billing-migration"), ["ana-agent", "ben-agent"]);
    assert.deepEqual(await names("billing-prod"), ["ana-agent", "sam-agent"]);
  });
});

test("sessions older than a day and revoked tokens are left out", async () => {
  await withTestDb(async (db) => {
    const { ana, benAgent, samAgent } = await billingTeam(db);
    await heartbeat(db, benAgent.auth, { watching: ["billing-migration"] });
    await db`update presence set last_seen_at = now() - interval '25 hours' where token_id = ${benAgent.tokenId}`;
    await heartbeat(db, samAgent.auth, { watching: ["billing-migration"] });
    await revokeToken(db, samAgent.tokenId);
    assert.deepEqual(await listPresence(db, ana.auth, "billing-migration"), []);
  });
});

test("only an agent token reports presence, with valid input", async () => {
  await withTestDb(async (db) => {
    const { ben, benAgent } = await billingTeam(db);
    await assert.rejects(heartbeat(db, ben.auth, { watching: [] }), code("forbidden"));
    await assert.rejects(heartbeat(db, { ...benAgent.auth, via: "system", tokenId: undefined }, { watching: [] }), code("forbidden"));
    await assert.rejects(heartbeat(db, benAgent.auth, { watching: ["Billing Prod"] }), code("invalid_input"));
    const many = Array.from({ length: 51 }, (_, i) => `room-${i}`);
    await assert.rejects(heartbeat(db, benAgent.auth, { watching: many }), code("invalid_input"));
    await assert.rejects(heartbeat(db, benAgent.auth, { watching: [], status: "x".repeat(201) }), code("invalid_input"));
  });
});

test("reading presence needs read in the room; loadPresence checks none", async () => {
  await withTestDb(async (db) => {
    const { benAgent, samAgent } = await billingTeam(db);
    await heartbeat(db, samAgent.auth, { watching: ["billing-prod"] });
    await db`delete from grants where actor_id = ${benAgent.actor.id} and room_pattern = 'billing-prod'`;
    await assert.rejects(listPresence(db, benAgent.auth, "billing-prod"), code("forbidden"));
    assert.deepEqual((await loadPresence(db, "billing-prod")).map((p) => p.actor.name), ["sam-agent"]);
  });
});
