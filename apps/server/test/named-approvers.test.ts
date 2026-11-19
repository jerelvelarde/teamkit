import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { billingTeam, blockedTask, PROD_APPROVAL } from "./helpers/team.js";
import { answer } from "../src/store/blocks.js";
import { listEvents } from "../src/store/events.js";
import { setRoom } from "../src/store/rooms.js";
import { loadTask } from "../src/store/task-load.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

test("a block naming sam stores the approvers once and logs them in task.blocked", async () => {
  await withTestDb(async (db) => {
    const { benAgent } = await billingTeam(db);
    const t = await blockedTask(db, benAgent, "billing-prod", { ...PROD_APPROVAL, approvers: ["sam", "sam"] });
    assert.deepEqual(t.block!.approvers, ["sam"]);
    const [e] = (await listEvents(db, { kinds: ["task.blocked"] })).events;
    assert.deepEqual(e!.data.approvers, ["sam"]);
  });
});

test("named approvers of an approval must be people on the room's approver list", async () => {
  await withTestDb(async (db) => {
    const { benAgent } = await billingTeam(db);
    const tooMany = Array.from({ length: 11 }, () => "sam");
    for (const approvers of [["ben"], ["ben-agent"], ["nobody"], [], tooMany]) {
      await assert.rejects(blockedTask(db, benAgent, "billing-prod", { ...PROD_APPROVAL, approvers }), code("invalid_input"));
    }
  });
});

test("with no approver list any person may be named, and a question may name anyone", async () => {
  await withTestDb(async (db) => {
    const { benAgent } = await billingTeam(db);
    const a = await blockedTask(db, benAgent, "billing-migration", { ...PROD_APPROVAL, approvers: ["ben"] });
    assert.deepEqual(a.block!.approvers, ["ben"]);
    const q = await blockedTask(db, benAgent, "billing-prod", { kind: "needs_input", question: "Which type for currency_code?", approvers: ["ben"] });
    assert.deepEqual(q.block!.approvers, ["ben"]);
  });
});

test("only the named approver answers; the room's other approvers are refused", async () => {
  await withTestDb(async (db) => {
    const { benAgent, ben, sam } = await billingTeam(db);
    await setRoom(db, "billing-prod", { approvers: ["sam", "ben"] });
    const t = await blockedTask(db, benAgent, "billing-prod", { ...PROD_APPROVAL, approvers: ["sam"] });
    await assert.rejects(answer(db, ben.auth, t.id, { choice: "approve" }), code("approval_requires_person"));
    assert.equal((await answer(db, sam.auth, t.id, { choice: "approve" })).state, "ready");
  });
});

test("an admin answers any approval, named or listed, but only signed in", async () => {
  await withTestDb(async (db) => {
    const { benAgent, ana } = await billingTeam(db);
    const t1 = await blockedTask(db, benAgent, "billing-prod", { ...PROD_APPROVAL, approvers: ["sam"] });
    assert.equal((await answer(db, ana.auth, t1.id, { choice: "approve" })).state, "ready");
    const t2 = await blockedTask(db, benAgent, "billing-prod", PROD_APPROVAL);
    assert.equal((await answer(db, ana.auth, t2.id, { choice: "approve" })).state, "ready");
    const t3 = await blockedTask(db, benAgent, "billing-prod", { ...PROD_APPROVAL, approvers: ["sam"] });
    await assert.rejects(answer(db, { ...ana.auth, via: "token" }, t3.id, { choice: "approve" }), code("approval_requires_person"));
  });
});

test("a question naming ben is answered only by ben or an admin", async () => {
  await withTestDb(async (db) => {
    const { benAgent, anaAgent, ben, sam } = await billingTeam(db);
    const t = await blockedTask(db, benAgent, "billing-migration", { kind: "needs_input", question: "Which type for currency_code?", approvers: ["ben"] });
    await assert.rejects(answer(db, anaAgent.auth, t.id, { text: "numeric(3)" }), code("approval_requires_person"));
    await assert.rejects(answer(db, sam.auth, t.id, { text: "numeric(3)" }), code("approval_requires_person"));
    assert.equal((await answer(db, ben.auth, t.id, { text: "numeric(3)" })).state, "ready");
  });
});

test("a block stored before named approvers is answered under the room rule", async () => {
  await withTestDb(async (db) => {
    const { benAgent, ben, sam } = await billingTeam(db);
    const t = await blockedTask(db, benAgent, "billing-prod", PROD_APPROVAL);
    await db`update tasks set block = block - 'approvers' where thread_id = ${t.id}`;
    assert.equal((await loadTask(db, t.id))!.block!.approvers, null);
    await assert.rejects(answer(db, ben.auth, t.id, { choice: "approve" }), code("approval_requires_person"));
    assert.equal((await answer(db, sam.auth, t.id, { choice: "approve" })).state, "ready");
  });
});
