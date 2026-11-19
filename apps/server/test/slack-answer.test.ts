import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { createTask } from "../src/store/tasks.js";
import { claimTask } from "../src/store/claims.js";
import { answer, block } from "../src/store/blocks.js";
import { setRoom } from "../src/store/rooms.js";
import { loadTask } from "../src/store/task-load.js";
import { createSlackLinkCode, previewSlackLinkCode, redeemSlackLinkCode } from "../src/slack/links.js";
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

async function setup(db: Parameters<typeof agentAuth>[0], options = ["approve", "reject"]) {
  const ada = await personAuth(db, "ada");
  const bob = await personAuth(db, "bob");
  await setRoom(db, "build", { approvers: ["ada"] });
  const bot = await agentAuth(db, "bot");
  const t = await createTask(db, bot, { room: "build", brief: "x" });
  const c = await claimTask(db, bot, t.id);
  const blocked = await block(db, bot, t.id, c.claimId, { question: "ship?", kind: "awaiting_approval", options });
  const link = async (who: typeof ada, slackUser: string) =>
    redeemSlackLinkCode(db, who, await createSlackLinkCode(db, slackUser), slackUser);
  await link(ada, "UADA");
  await link(bob, "UBOB");
  const value = { taskId: t.id, interruptId: blocked.block!.interruptId, choice: options[0]! };
  return { t, bot, ada, value, handler: createSlackAnswerHandler({ db, publicUrl: "http://x.test" }) };
}

const click = (s: ReturnType<typeof stubThread>, slackUserId: string, value: unknown, slackUserName: string | null = null) => ({
  thread: s.thread,
  slackUserId,
  slackUserName,
  value,
});

test("a linked approver's click answers the task as that person", async () => {
  await withTestDb(async (db) => {
    const { t, value, handler } = await setup(db);
    const s = stubThread();
    await handler.onAnswer(click(s, "UADA", value));
    const after = await loadTask(db, t.id);
    assert.equal(after!.state, "ready");
    assert.equal(after!.pendingResume?.[0]?.payload?.choice, "approve");
    assert.equal(s.posts.length, 0);
    assert.equal(s.ephemerals.length, 0);
  });
});

test("an unlinked click gets a link prompt for its own Slack handle and answers nothing", async () => {
  await withTestDb(async (db) => {
    const { t, ada, value, handler } = await setup(db);
    const s = stubThread();
    await handler.onAnswer(click(s, "UNOBODY", value, "nobody.here"));
    assert.equal(s.ephemerals.length, 1);
    assert.equal(s.ephemerals[0]!.user, "UNOBODY");
    const m = /\/link\/slack\?code=(slk_[A-Za-z0-9_-]+)/.exec(String(s.ephemerals[0]!.ui));
    assert.ok(m, String(s.ephemerals[0]!.ui));
    const preview = await previewSlackLinkCode(db, ada, m[1]!);
    assert.deepEqual([preview.slackUserId, preview.slackUserName], ["UNOBODY", "nobody.here"]);
    assert.equal(s.posts.length, 0);
    assert.equal((await loadTask(db, t.id))!.state, "blocked");
  });
});

test("a linked non-approver cannot answer an approval", async () => {
  await withTestDb(async (db) => {
    const { t, value, handler } = await setup(db);
    const s = stubThread();
    await handler.onAnswer(click(s, "UBOB", value));
    assert.match(String(s.ephemerals[0]!.ui), /^Only a listed approver/);
    assert.equal(s.posts.length, 0);
    assert.equal((await loadTask(db, t.id))!.state, "blocked");
  });
});

test("a stale interrupt id is rejected", async () => {
  await withTestDb(async (db) => {
    const { t, value, handler } = await setup(db);
    const s = stubThread();
    await handler.onAnswer(click(s, "UADA", { ...value, interruptId: "int_old" }));
    assert.equal(s.ephemerals[0]!.ui, "This question was already answered.");
    assert.equal((await loadTask(db, t.id))!.state, "blocked");
    // answering twice: the second click finds the task no longer blocked
    await handler.onAnswer(click(s, "UADA", value));
    await handler.onAnswer(click(s, "UADA", value));
    assert.equal(s.ephemerals[1]!.ui, "This question was already answered.");
    assert.equal(s.posts.length, 0);
  });
});

test("a click on an old card never answers the newer question the task is blocked on", async () => {
  await withTestDb(async (db) => {
    const { t, bot, ada, value, handler } = await setup(db);
    // The first question is answered on the web and the agent asks a new one.
    await answer(db, ada, t.id, { choice: "approve" });
    const c = await claimTask(db, bot, t.id);
    await block(db, bot, t.id, c.claimId, { question: "really?", kind: "awaiting_approval", options: ["approve", "reject"] });
    const s = stubThread();
    await handler.onAnswer(click(s, "UADA", value));
    assert.equal(s.ephemerals[0]!.ui, "This question was already answered.");
    const after = (await loadTask(db, t.id))!;
    assert.equal(after.state, "blocked");
    assert.equal(after.block?.question, "really?");
  });
});

test("the choice, the name and error messages are escaped before they reach Slack", async () => {
  await withTestDb(async (db) => {
    const evil = "<!channel> [x](http://evil.test)";
    const { t, value, handler } = await setup(db, [evil, "reject"]);
    const s = stubThread();
    // A choice that is not an option: the error message quotes it.
    await handler.onAnswer(click(s, "UADA", { ...value, choice: "<!here> [y](http://evil.test)" }));
    const err = String(s.ephemerals[0]!.ui);
    assert.match(err, /&lt;!here&gt;/);
    assert.ok(!err.includes("<!here>"));
    assert.ok(!err.includes("](http"));

    await handler.onAnswer(click(s, "UADA", value));
    assert.equal((await loadTask(db, t.id))!.pendingResume?.[0]?.payload?.choice, evil);
    assert.equal(s.posts.length, 0);
  });
});

test("a malformed value is refused", async () => {
  await withTestDb(async (db) => {
    const { t, handler } = await setup(db);
    const s = stubThread();
    await handler.onAnswer(click(s, "UADA", "garbage"));
    assert.equal(s.ephemerals[0]!.ui, "This button is no longer valid.");
    assert.equal((await loadTask(db, t.id))!.state, "blocked");
  });
});

test("the value as a JSON string works like the object", async () => {
  await withTestDb(async (db) => {
    const { t, value, handler } = await setup(db);
    const s = stubThread();
    await handler.onAnswer(click(s, "UADA", JSON.stringify(value)));
    assert.equal((await loadTask(db, t.id))!.state, "ready");
    assert.equal(s.posts.length, 0);
  });
});
