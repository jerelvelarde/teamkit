import { test } from "node:test";
import assert from "node:assert/strict";
import type { BlockKind } from "@copilotkit/teamkit-protocol";
import type { Db } from "../src/db/pool.js";
import { createSlackAnswerHandler, type SlackAnswerThread } from "../src/slack/answer.js";
import { createSlackHandlers, ensureSlackGuest, type SlackThreadLike } from "../src/slack/handlers.js";
import { unlinkSlackUser } from "../src/slack/links.js";
import { saveSlackThread } from "../src/slack/mirror.js";
import { processOutboundOnce } from "../src/slack/outbound.js";
import { block } from "../src/store/blocks.js";
import { claimTask } from "../src/store/claims.js";
import { loadTask } from "../src/store/task-load.js";
import { createTask } from "../src/store/tasks.js";
import { CHANNEL, SLACK_USER, seedBilling, type Billing } from "./helpers/billing.js";
import { withTestDb } from "./helpers/db.js";
import { fakeSlack, outboundOptions as out } from "./helpers/fake-slack.js";

function stubThread() {
  const posts: unknown[] = [];
  const ephemerals: { user: unknown; ui: unknown }[] = [];
  const thread: SlackAnswerThread & SlackThreadLike = {
    conversationKey: "C0BILLPRD::7.000",
    async post(ui: unknown) {
      posts.push(ui);
      return { id: "m1" };
    },
    async postEphemeral(user: unknown, ui: unknown) {
      ephemerals.push({ user, ui });
      return {};
    },
  } as SlackAnswerThread & SlackThreadLike;
  return { thread, posts, ephemerals };
}
const click = (s: ReturnType<typeof stubThread>, slackUserId: string, value: unknown) => ({ thread: s.thread, slackUserId, slackUserName: null, value });

async function ask(db: Db, b: Billing, room: string, input: { kind: BlockKind; approvers?: string[]; options?: string[] }) {
  const t = await createTask(db, b.benAgent, { room, brief: "Enable writes on the new invoices table" });
  const c = await claimTask(db, b.benAgent, t.id);
  const blocked = await block(db, b.benAgent, t.id, c.claimId, {
    question: "Approve the cutover write to billing-prod?",
    options: input.options ?? ["approve", "reject"],
    kind: input.kind,
    ...(input.approvers ? { approvers: input.approvers } : {}),
  });
  return { t, value: { taskId: t.id, interruptId: blocked.block!.interruptId, choice: (input.options ?? ["approve"])[0]! } };
}

test("an ask naming sam mentions sam's Slack user at the top level", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      const b = await seedBilling(db);
      await processOutboundOnce(out(db, slack.apiBase));
      await ask(db, b, "billing-prod", { kind: "awaiting_approval", approvers: ["sam"] });
      await processOutboundOnce(out(db, slack.apiBase));
      const body = slack.requests.at(-1)!.body;
      assert.equal(body.text, "Needs approval from <@U0SAM>: Approve the cutover write to billing-prod?");
      assert.ok(JSON.stringify(body.blocks).includes("Waiting on <@U0SAM>"));
    });
  } finally {
    await slack.close();
  }
});

test("room approvers are named when the ask names none; an unlinked approver is named, not mentioned", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      const b = await seedBilling(db);
      await processOutboundOnce(out(db, slack.apiBase));
      const blocksOfLast = () => JSON.stringify(slack.requests.at(-1)!.body.blocks);
      await ask(db, b, "billing-prod", { kind: "awaiting_approval" });
      await processOutboundOnce(out(db, slack.apiBase));
      assert.ok(blocksOfLast().includes("Waiting on <@U0SAM>"));
      await unlinkSlackUser(db, SLACK_USER.sam);
      await ask(db, b, "billing-prod", { kind: "awaiting_approval" });
      await processOutboundOnce(out(db, slack.apiBase));
      assert.ok(blocksOfLast().includes("Waiting on sam"));
      assert.ok(!blocksOfLast().includes("<@U0SAM>"));
      await ask(db, b, "billing-migration", { kind: "needs_input" });
      await processOutboundOnce(out(db, slack.apiBase));
      assert.ok(blocksOfLast().includes("Anyone in billing-migration can answer"));
    });
  } finally {
    await slack.close();
  }
});

test("buttons answer only for the named approver, the room approver or an admin", async () => {
  await withTestDb(async (db) => {
    const b = await seedBilling(db);
    const h = createSlackAnswerHandler({ db, publicUrl: "http://board.test" });
    const named = await ask(db, b, "billing-prod", { kind: "awaiting_approval", approvers: ["sam"] });
    const s = stubThread();
    await h.onAnswer(click(s, SLACK_USER.ben, named.value));
    assert.equal(s.ephemerals[0]!.ui, "This waits on sam. Only sam or an admin can answer it.");
    assert.equal((await loadTask(db, named.t.id))!.state, "blocked");
    await h.onAnswer(click(s, SLACK_USER.sam, named.value));
    assert.equal((await loadTask(db, named.t.id))!.state, "ready");

    const byAdmin = await ask(db, b, "billing-prod", { kind: "awaiting_approval", approvers: ["sam"] });
    await h.onAnswer(click(s, SLACK_USER.ana, byAdmin.value));
    assert.equal((await loadTask(db, byAdmin.t.id))!.state, "ready");

    const byRoom = await ask(db, b, "billing-prod", { kind: "awaiting_approval" });
    await h.onAnswer(click(s, SLACK_USER.ben, byRoom.value));
    assert.equal(s.ephemerals.at(-1)!.ui, "This waits on sam. Only sam or an admin can answer it.");
    await h.onAnswer(click(s, SLACK_USER.sam, byRoom.value));
    assert.equal((await loadTask(db, byRoom.t.id))!.state, "ready");

    const input = await ask(db, b, "billing-migration", { kind: "needs_input", approvers: ["ana"], options: ["500", "5000"] });
    await h.onAnswer(click(s, SLACK_USER.ben, input.value));
    assert.equal(s.ephemerals.at(-1)!.ui, "This waits on ana. Only ana or an admin can answer it.");
    await h.onAnswer(click(s, SLACK_USER.ana, input.value));
    assert.equal((await loadTask(db, input.t.id))!.state, "ready");
    assert.equal(s.posts.length, 0);
  });
});

test("a reply naming an option is refused the same way for someone the ask does not wait on", async () => {
  await withTestDb(async (db) => {
    const b = await seedBilling(db);
    const { t } = await ask(db, b, "billing-prod", { kind: "awaiting_approval", approvers: ["sam"] });
    await saveSlackThread(db, { taskId: t.id, channel: CHANNEL.prod, ts: "7.000", conversationKey: "C0BILLPRD::7.000" });
    const h = createSlackHandlers({ db, publicUrl: "http://board.test", defaultRoom: null, guest: await ensureSlackGuest(db) });
    const s = stubThread();
    await h.onMessage({ thread: s.thread, text: "approve", slackUserId: SLACK_USER.ben, slackUserName: "ben", coordinates: null });
    assert.equal(s.ephemerals.length, 1);
    assert.equal(s.ephemerals[0]!.ui, "This waits on sam. Only sam or an admin can answer it.");
    assert.equal((await loadTask(db, t.id))!.state, "blocked");
  });
});
