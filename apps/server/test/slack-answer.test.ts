import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { createTask } from "../src/store/tasks.js";
import { claimTask } from "../src/store/claims.js";
import { block } from "../src/store/blocks.js";
import { setRoom } from "../src/store/rooms.js";
import { loadTask } from "../src/store/task-load.js";
import { createSlackLinkCode, redeemSlackLinkCode } from "../src/slack/links.js";
import { createSlackAnswerHandler, type SlackAnswerThread } from "../src/slack/answer.js";

function stubThread() {
  const posts: unknown[] = [];
  const ephemerals: { user: unknown; ui: unknown }[] = [];
  const thread: SlackAnswerThread = {
    async post(ui) {
      posts.push(ui);
      return { id: "m1" };
    },
    async postEphemeral(user, ui) {
      ephemerals.push({ user, ui });
      return {};
    },
  };
  return { thread, posts, ephemerals };
}

async function setup(db: Parameters<typeof agentAuth>[0]) {
  const ada = await personAuth(db, "ada");
  const bob = await personAuth(db, "bob");
  await setRoom(db, "build", { approvers: ["ada"] });
  const bot = await agentAuth(db, "bot");
  const t = await createTask(db, bot, { room: "build", brief: "x" });
  const c = await claimTask(db, bot, t.id);
  const blocked = await block(db, bot, t.id, c.claimId, {
    question: "ship?",
    kind: "awaiting_approval",
    options: ["approve", "reject"],
  });
  const link = async (who: typeof ada, slackUser: string) =>
    redeemSlackLinkCode(db, who, await createSlackLinkCode(db, slackUser));
  await link(ada, "UADA");
  await link(bob, "UBOB");
  const value = { taskId: t.id, interruptId: blocked.block!.interruptId, choice: "approve" };
  return { t, value, handler: createSlackAnswerHandler({ db, publicUrl: "http://x.test" }) };
}

test("a linked approver's click answers the task as that person", async () => {
  await withTestDb(async (db) => {
    const { t, value, handler } = await setup(db);
    const s = stubThread();
    await handler.onAnswer({ thread: s.thread, slackUserId: "UADA", value });
    const after = await loadTask(db, t.id);
    assert.equal(after!.state, "ready");
    assert.equal(after!.pendingResume?.[0]?.payload?.choice, "approve");
    assert.deepEqual(s.posts, ["ada answered: approve"]);
    assert.equal(s.ephemerals.length, 0);
  });
});

test("an unlinked click gets a link prompt and answers nothing", async () => {
  await withTestDb(async (db) => {
    const { t, value, handler } = await setup(db);
    const s = stubThread();
    await handler.onAnswer({ thread: s.thread, slackUserId: "UNOBODY", value });
    assert.equal(s.ephemerals.length, 1);
    assert.equal(s.ephemerals[0]!.user, "UNOBODY");
    assert.match(String(s.ephemerals[0]!.ui), /\/link\/slack\?code=slk_/);
    assert.equal(s.posts.length, 0);
    assert.equal((await loadTask(db, t.id))!.state, "blocked");
  });
});

test("a linked non-approver cannot answer an approval", async () => {
  await withTestDb(async (db) => {
    const { t, value, handler } = await setup(db);
    const s = stubThread();
    await handler.onAnswer({ thread: s.thread, slackUserId: "UBOB", value });
    assert.match(String(s.ephemerals[0]!.ui), /^Only a listed approver/);
    assert.equal(s.posts.length, 0);
    assert.equal((await loadTask(db, t.id))!.state, "blocked");
  });
});

test("a stale interrupt id is rejected", async () => {
  await withTestDb(async (db) => {
    const { t, value, handler } = await setup(db);
    const s = stubThread();
    await handler.onAnswer({ thread: s.thread, slackUserId: "UADA", value: { ...value, interruptId: "int_old" } });
    assert.equal(s.ephemerals[0]!.ui, "This question was already answered.");
    assert.equal((await loadTask(db, t.id))!.state, "blocked");
    // answering twice: the second click finds the task no longer blocked
    await handler.onAnswer({ thread: s.thread, slackUserId: "UADA", value });
    await handler.onAnswer({ thread: s.thread, slackUserId: "UADA", value });
    assert.equal(s.ephemerals[1]!.ui, "This question was already answered.");
    assert.equal(s.posts.length, 1);
  });
});

test("a malformed value is refused", async () => {
  await withTestDb(async (db) => {
    const { t, handler } = await setup(db);
    const s = stubThread();
    await handler.onAnswer({ thread: s.thread, slackUserId: "UADA", value: "garbage" });
    assert.equal(s.ephemerals[0]!.ui, "This button is no longer valid.");
    assert.equal((await loadTask(db, t.id))!.state, "blocked");
  });
});

test("the value as a JSON string works like the object", async () => {
  await withTestDb(async (db) => {
    const { t, value, handler } = await setup(db);
    const s = stubThread();
    await handler.onAnswer({ thread: s.thread, slackUserId: "UADA", value: JSON.stringify(value) });
    assert.equal((await loadTask(db, t.id))!.state, "ready");
    assert.deepEqual(s.posts, ["ada answered: approve"]);
  });
});
