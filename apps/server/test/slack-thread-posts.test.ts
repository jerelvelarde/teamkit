import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db/pool.js";
import { ensureSlackGuest } from "../src/slack/handlers.js";
import { saveSlackThread } from "../src/slack/mirror.js";
import { processOutboundOnce } from "../src/slack/outbound.js";
import { answer, block } from "../src/store/blocks.js";
import { logChange, updateChange } from "../src/store/changes.js";
import { claimTask, complete } from "../src/store/claims.js";
import { setRoom } from "../src/store/rooms.js";
import { createTask } from "../src/store/tasks.js";
import { reply } from "../src/store/threads.js";
import { api, CHANNEL, seedBilling } from "./helpers/billing.js";
import { withTestDb } from "./helpers/db.js";
import { fakeSlack, outboundOptions as out, type SlackRequest } from "./helpers/fake-slack.js";
import { startTestServer } from "./helpers/server.js";

const ASK = { question: "Approve the cutover write to billing-prod?", kind: "awaiting_approval" as const, options: ["approve", "reject"] };
const texts = (rs: SlackRequest[]) => rs.map((r) => r.body.text);

async function askedTask(db: Db, b: Awaited<ReturnType<typeof seedBilling>>) {
  const t = await createTask(db, b.benAgent, { room: "billing-migration", brief: "Copy the invoices table to the new database" });
  const c = await claimTask(db, b.benAgent, t.id);
  await block(db, b.benAgent, t.id, c.claimId, ASK);
  return t;
}

test("a board task stays out of Slack until it asks; then its events thread under the ask", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      const b = await seedBilling(db);
      await processOutboundOnce(out(db, slack.apiBase));
      const t = await createTask(db, b.benAgent, { room: "billing-migration", brief: "Copy the invoices table to the new database" });
      const c = await claimTask(db, b.benAgent, t.id);
      await reply(db, b.benAgent, t.id, "Copied 40% of invoice rows.");
      assert.equal((await processOutboundOnce(out(db, slack.apiBase))).posted, 0);
      await block(db, b.benAgent, t.id, c.claimId, ASK);
      assert.equal((await processOutboundOnce(out(db, slack.apiBase))).posted, 1);
      assert.deepEqual([slack.requests[0]!.body.channel, slack.requests[0]!.body.thread_ts], [CHANNEL.migration, undefined]);
      await answer(db, b.ana, t.id, { choice: "approve" });
      const c2 = await claimTask(db, b.benAgent, t.id);
      await reply(db, b.benAgent, t.id, "Cutover write done.");
      await complete(db, b.benAgent, t.id, c2.claimId, "Invoices now read from the new database.");
      assert.equal((await processOutboundOnce(out(db, slack.apiBase))).posted, 4);
      const rest = slack.requests.slice(1);
      assert.ok(rest.every((r) => r.body.thread_ts === "1.000" && r.body.channel === CHANNEL.migration && !r.body.reply_broadcast));
      assert.deepEqual(texts(rest.slice(0, 3)), ["ana answered: approve", "ben-agent claimed this task.", "*ben-agent:* Cutover write done."]);
      assert.match(JSON.stringify(rest[3]!.body.blocks), /Invoices now read from the new database/);
    });
  } finally {
    await slack.close();
  }
});

test("a second ask on a task with a thread posts in it and to the channel", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      const b = await seedBilling(db);
      await processOutboundOnce(out(db, slack.apiBase));
      const t = await askedTask(db, b);
      await processOutboundOnce(out(db, slack.apiBase));
      await answer(db, b.ana, t.id, { choice: "approve" });
      const c2 = await claimTask(db, b.benAgent, t.id);
      await block(db, b.benAgent, t.id, c2.claimId, { question: "Approve dropping the old invoices table?", kind: "awaiting_approval", options: ["approve", "reject"] });
      await processOutboundOnce(out(db, slack.apiBase));
      const last = slack.requests.at(-1)!;
      assert.equal(last.body.thread_ts, "1.000");
      assert.equal(last.body.reply_broadcast, true);
      assert.match(JSON.stringify(last.body.blocks), /Approve dropping the old invoices table\?/);
    });
  } finally {
    await slack.close();
  }
});

test("a task a person created from Slack threads its claims under the mention, with no card for its creation", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      const b = await seedBilling(db);
      await processOutboundOnce(out(db, slack.apiBase));
      const t = await createTask(db, b.ana, { room: "billing-migration", brief: "Check the invoice counts", labels: { source: "slack" } });
      await saveSlackThread(db, { taskId: t.id, channel: CHANNEL.migration, ts: "50.000", conversationKey: "C0BILLMIG::50.000" });
      await claimTask(db, b.samAgent, t.id);
      assert.equal((await processOutboundOnce(out(db, slack.apiBase))).posted, 1);
      assert.equal(slack.requests[0]!.body.thread_ts, "50.000");
      assert.equal(slack.requests[0]!.body.text, "sam-agent claimed this task.");
    });
  } finally {
    await slack.close();
  }
});

test("announce all gives a task a card at the top first, then threads its events", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      const b = await seedBilling(db);
      await processOutboundOnce(out(db, slack.apiBase));
      const early = await createTask(db, b.benAgent, { room: "billing-migration", brief: "Back up the old invoices table" });
      assert.equal((await processOutboundOnce(out(db, slack.apiBase))).posted, 0);
      await setRoom(db, "billing-migration", { slackAnnounce: "all" });
      const t = await createTask(db, b.benAgent, { room: "billing-migration", brief: "Rebuild the invoice indexes" });
      await claimTask(db, b.benAgent, t.id);
      await claimTask(db, b.benAgent, early.id);
      assert.equal((await processOutboundOnce(out(db, slack.apiBase))).posted, 4);
      // The stand-in numbers every chat.postMessage, thread replies included: the claim line under
      // the first card is 2.000, so the early task's card is 3.000 and its line threads under it.
      assert.deepEqual(slack.requests.map((r) => r.body.thread_ts), [undefined, "1.000", undefined, "3.000"]);
      const said = texts(slack.requests);
      assert.equal(said[1], "ben-agent claimed this task.");
      assert.equal(said[3], "ben-agent claimed this task.");
    });
  } finally {
    await slack.close();
  }
});

test("agents' replies go in the thread; people's and Slack guests' replies never echo back", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      const b = await seedBilling(db);
      await processOutboundOnce(out(db, slack.apiBase));
      const t = await askedTask(db, b);
      await processOutboundOnce(out(db, slack.apiBase));
      await reply(db, b.sam, t.id, "Looks right to me.");
      await reply(db, await ensureSlackGuest(db), t.id, "U0BEN: any news?", { asUser: true });
      await reply(db, b.benAgent, t.id, "Waiting for the approval.");
      assert.equal((await processOutboundOnce(out(db, slack.apiBase))).posted, 1);
      assert.equal(slack.requests.at(-1)!.body.text, "*ben-agent:* Waiting for the approval.");
    });
  } finally {
    await slack.close();
  }
});

test("a handoff and a change-log line go in the task's thread; a change with no task posts nothing", async () => {
  const slack = await fakeSlack();
  const s = await startTestServer();
  try {
    const b = await seedBilling(s.db);
    await processOutboundOnce(out(s.db, slack.apiBase));
    const t = await askedTask(s.db, b);
    await processOutboundOnce(out(s.db, slack.apiBase));
    await answer(s.db, b.ana, t.id, { choice: "approve" });
    await claimTask(s.db, b.benAgent, t.id);
    await api(s.url, b.benAgent.token, `/v1/tasks/${t.id}/handoff`, { to: "sam-agent" });
    await api(s.url, b.samAgent.token, "/v1/changes", { room: "billing-migration", threadId: t.id, what: "Switched invoice writes to the new database",
      where: "billing-prod", undo: "Point invoice writes back to the old database", undoWhen: "after the 18:00 UTC check" });
    await api(s.url, b.samAgent.token, "/v1/changes", { room: "billing-migration", what: "Raised the invoice table's connection limit",
      where: "billing-prod", undo: "Set the connection limit back to 100" });
    await processOutboundOnce(out(s.db, slack.apiBase));
    assert.deepEqual(texts(slack.requests.slice(1)), [
      "ana answered: approve",
      "ben-agent claimed this task.",
      "ben-agent handed this task to sam-agent. It is held for sam-agent for 30 min.",
      "Change logged by sam-agent for sam: Switched invoice writes to the new database · where: billing-prod · undo: Point invoice writes back to the old database · undo when: after the 18:00 UTC check",
    ]);
  } finally {
    await s.stop();
    await slack.close();
  }
});

test("two quick status changes post each status, not the latest twice", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      const b = await seedBilling(db);
      await processOutboundOnce(out(db, slack.apiBase));
      const t = await askedTask(db, b);
      const c = await logChange(db, b.samAgent, { room: "billing-migration", threadId: t.id, what: "Switched invoice writes to the new database",
        where: "billing-prod", undo: "Point invoice writes back to the old database" });
      await processOutboundOnce(out(db, slack.apiBase));
      const n = slack.requests.length;
      await updateChange(db, b.samAgent, c.id, "done");
      await updateChange(db, b.samAgent, c.id, "restored");
      await processOutboundOnce(out(db, slack.apiBase));
      assert.deepEqual(texts(slack.requests.slice(n)), [
        "sam-agent marked a change done: Switched invoice writes to the new database",
        "sam-agent marked a change restored: Switched invoice writes to the new database",
      ]);
    });
  } finally {
    await slack.close();
  }
});
