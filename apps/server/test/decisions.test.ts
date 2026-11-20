import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { assertAguiValid } from "./helpers/agui.js";
import { FREEZE, billingTeam } from "./helpers/team.js";
import { ackDecision, listDecisions, postDecision } from "../src/store/decisions.js";
import { listEvents } from "../src/store/events.js";
import { getThread } from "../src/store/threads.js";

const code = (c: string, msg?: RegExp) => (e: unknown) =>
  (e as { code?: string }).code === c && (msg === undefined || msg.test((e as Error).message));
const said = async (db: Parameters<typeof getThread>[0], auth: Parameters<typeof getThread>[1], threadId: string) =>
  (await getThread(db, auth, threadId)).messages.map((m) => [m.role, (m as { name?: string }).name, (m as { content?: string }).content]);

test("sam posts a decision on its own thread: decided and posted by sam", async () => {
  await withTestDb(async (db) => {
    const { sam } = await billingTeam(db);
    const d = await postDecision(db, sam.auth, { room: "billing-migration", text: FREEZE });
    assert.deepEqual([d.decidedBy, d.postedBy, d.acks], [sam.actor, sam.actor, []]);
    assert.deepEqual(await said(db, sam.auth, d.threadId), [["user", "sam", `Decision by sam: ${FREEZE}`]]);
    const [e] = (await listEvents(db, { kinds: ["decision.posted"] })).events;
    assert.equal(e!.threadId, d.threadId);
    assert.equal(e!.data.decisionId, d.id);
    assert.deepEqual(e!.agui.map((x) => x.type), ["CUSTOM", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]);
    assert.deepEqual((e!.agui[0] as unknown as { value: unknown }).value,
      { decisionId: d.id, room: "billing-migration", text: FREEZE, decidedBy: sam.actor, postedBy: sam.actor });
    assertAguiValid(e!.agui);
  });
});

test("ana-agent posts a decision for its owner: decided by ana, posted by ana-agent", async () => {
  await withTestDb(async (db) => {
    const { ana, anaAgent } = await billingTeam(db);
    const d = await postDecision(db, anaAgent.auth, { room: "billing-migration", text: FREEZE, decidedBy: "ana" });
    assert.deepEqual([d.decidedBy, d.postedBy], [ana.actor, anaAgent.actor]);
    assert.deepEqual(await said(db, ana.auth, d.threadId), [["assistant", "ana-agent", `Decision by ana: ${FREEZE}`]]);
  });
});

test("an agent must name its own owner as the decider", async () => {
  await withTestDb(async (db) => {
    const { anaAgent, samAgent, benAgent } = await billingTeam(db);
    const input = { room: "billing-migration", text: FREEZE };
    await assert.rejects(postDecision(db, anaAgent.auth, input), code("invalid_input"));
    await assert.rejects(postDecision(db, anaAgent.auth, { ...input, decidedBy: "sam" }), code("forbidden"));
    await assert.rejects(postDecision(db, anaAgent.auth, { ...input, decidedBy: "ben-agent" }), code("forbidden"));
    await db`update actors set owner_id = null where id = ${samAgent.actor.id}`;
    await assert.rejects(postDecision(db, samAgent.auth, { ...input, decidedBy: "sam" }), code("forbidden", /has no owner/));
    await db`update actors set owner_id = ${anaAgent.actor.id} where id = ${benAgent.actor.id}`;
    await assert.rejects(postDecision(db, benAgent.auth, { ...input, decidedBy: "ana-agent" }), code("forbidden", /has no owner/));
  });
});

test("a person decides only for themselves", async () => {
  await withTestDb(async (db) => {
    const { ben } = await billingTeam(db);
    await assert.rejects(postDecision(db, ben.auth, { room: "billing-migration", text: FREEZE, decidedBy: "sam" }), code("invalid_input"));
    const d = await postDecision(db, ben.auth, { room: "billing-migration", text: FREEZE, decidedBy: "ben" });
    assert.deepEqual(d.decidedBy, ben.actor);
  });
});

test("acks are recorded once and block nothing", async () => {
  await withTestDb(async (db) => {
    const { sam, benAgent, anaAgent } = await billingTeam(db);
    const d = await postDecision(db, sam.auth, { room: "billing-migration", text: FREEZE });
    await ackDecision(db, benAgent.auth, d.id);
    const once = await ackDecision(db, benAgent.auth, d.id);
    assert.equal(once.acks.length, 1);
    assert.deepEqual(once.acks[0]!.actor, benAgent.actor);
    assert.equal((await listEvents(db, { kinds: ["decision.acked"] })).events.length, 1);
    const both = await ackDecision(db, anaAgent.auth, d.id);
    assert.deepEqual(both.acks.map((a) => a.actor), [benAgent.actor, anaAgent.actor]);
    const acked = (await listEvents(db, { kinds: ["decision.acked"] })).events;
    const last = acked[acked.length - 1]!;
    assert.deepEqual(last.data, { decisionId: d.id });
    assert.deepEqual((last.agui[0] as unknown as { value: unknown }).value, { decisionId: d.id, by: anaAgent.actor });
    assertAguiValid(last.agui);
  });
});

test("acking needs read in the decision's room; an unknown id is not_found", async () => {
  await withTestDb(async (db) => {
    const { sam, benAgent, anaAgent } = await billingTeam(db);
    const d = await postDecision(db, sam.auth, { room: "billing-migration", text: FREEZE });
    await db`delete from grants where actor_id = ${benAgent.actor.id} and room_pattern = 'billing-migration'`;
    await assert.rejects(ackDecision(db, benAgent.auth, d.id), code("forbidden"));
    await assert.rejects(ackDecision(db, anaAgent.auth, "dec_0000000000000000"), code("not_found"));
  });
});

test("decisions list newest first, honour limit, and need read", async () => {
  await withTestDb(async (db) => {
    const { sam, benAgent } = await billingTeam(db);
    const d1 = await postDecision(db, sam.auth, { room: "billing-migration", text: FREEZE });
    const d2 = await postDecision(db, sam.auth, { room: "billing-migration", text: "Run the backfill in 5000-row batches" });
    assert.deepEqual((await listDecisions(db, sam.auth, "billing-migration")).map((d) => d.id), [d2.id, d1.id]);
    assert.deepEqual((await listDecisions(db, sam.auth, "billing-migration", { limit: 1 })).map((d) => d.id), [d2.id]);
    await assert.rejects(listDecisions(db, sam.auth, "billing-migration", { limit: 0 }), code("invalid_input"));
    await db`delete from grants where actor_id = ${benAgent.actor.id} and room_pattern = 'billing-migration'`;
    await assert.rejects(listDecisions(db, benAgent.auth, "billing-migration"), code("forbidden"));
  });
});

test("decision text and room are validated", async () => {
  await withTestDb(async (db) => {
    const { sam } = await billingTeam(db);
    for (const text of ["", "x".repeat(2001), "a\u0000b"]) {
      await assert.rejects(postDecision(db, sam.auth, { room: "billing-migration", text }), code("invalid_input"));
    }
    await assert.rejects(postDecision(db, sam.auth, { room: "Billing Prod", text: FREEZE }), code("invalid_input"));
  });
});
