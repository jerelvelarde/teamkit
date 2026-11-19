import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db/pool.js";
import {
  createSlackHandlers,
  ensureSlackGuest,
  slackCoordinates,
  stripMention,
  type SlackThreadLike,
  type SlackTurn,
} from "../src/slack/handlers.js";
import { createSlackLinkCode, redeemSlackLinkCode } from "../src/slack/links.js";
import { getSlackThread } from "../src/slack/mirror.js";
import { answer, block } from "../src/store/blocks.js";
import { claimNext } from "../src/store/claims.js";
import { setRoom } from "../src/store/rooms.js";
import { loadTask } from "../src/store/task-load.js";
import { createTask } from "../src/store/tasks.js";
import { getThread } from "../src/store/threads.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { withTestDb } from "./helpers/db.js";

class StubThread implements SlackThreadLike {
  posts: unknown[] = [];
  ephemerals: { user: unknown; ui: unknown }[] = [];
  constructor(public conversationKey: string) {}
  async post(ui: unknown) {
    this.posts.push(ui);
    return { id: String(this.posts.length) };
  }
  async postEphemeral(user: { id: string } | string, ui: unknown) {
    this.ephemerals.push({ user, ui });
  }
}

function turn(thread: StubThread, text: string, slackUserId = "U1", coords: SlackTurn["coordinates"] = null): SlackTurn {
  return { thread, text, slackUserId, slackUserName: "sam", coordinates: coords };
}

async function setup(db: Db, defaultRoom: string | null = null) {
  const guest = await ensureSlackGuest(db);
  return createSlackHandlers({ db, publicUrl: "http://board.test", defaultRoom, guest });
}

async function link(db: Db, slackUserId: string, name: string, role: "admin" | "member" = "member") {
  const person = await personAuth(db, name, role);
  await redeemSlackLinkCode(db, person, await createSlackLinkCode(db, slackUserId), slackUserId);
  return person;
}

test("a mention by an unlinked user creates a guest task and posts a TaskCard", async () => {
  await withTestDb(async (db) => {
    await setRoom(db, "build", { slackChannel: "C1" });
    const h = await setup(db);
    const thread = new StubThread("C1::1.0");
    await h.onMention(turn(thread, "<@UBOT> fix the build", "U9", slackCoordinates("C1::1.0")));
    const [row] = await db`select thread_id from slack_threads where conversation_key = 'C1::1.0'`;
    const task = (await loadTask(db, row!.thread_id as string))!;
    assert.equal(task.room, "build");
    assert.equal(task.labels.source, "slack");
    assert.equal(task.createdBy.name, "slack-guest");
    assert.equal(task.createdBy.kind, "agent");
    assert.match(task.brief, /^fix the build\n\n\(from Slack user sam\)$/);
    assert.deepEqual(await getSlackThread(db, task.id), {
      taskId: task.id,
      channel: "C1",
      ts: "1.0",
      conversationKey: "C1::1.0",
    });
    assert.equal(thread.posts.length, 1);
    assert.notEqual(typeof thread.posts[0], "string");
  });
});

test("a mention by a linked person acts as that person", async () => {
  await withTestDb(async (db) => {
    await setRoom(db, "build", { slackChannel: "C1" });
    await link(db, "U2", "ada");
    const h = await setup(db);
    await h.onMention(turn(new StubThread("C1::2.0"), "<@UBOT> ship it", "U2", { channel: "C1", ts: "2.0" }));
    const [row] = await db`select thread_id from slack_threads`;
    const task = (await loadTask(db, row!.thread_id as string))!;
    assert.equal(task.createdBy.name, "ada");
    assert.equal(task.brief, "ship it");
  });
});

test("an unmapped channel posts guidance, or uses the default room", async () => {
  await withTestDb(async (db) => {
    const none = await setup(db);
    const t1 = new StubThread("C9::1.0");
    await none.onMention(turn(t1, "<@UBOT> hi", "U1", { channel: "C9", ts: "1.0" }));
    assert.match(String(t1.posts[0]), /isn't mapped to a TeamKit room/);
    assert.equal((await db`select 1 from tasks`).length, 0);

    const withDefault = await setup(db, "inbox");
    const t2 = new StubThread("C9::2.0");
    await withDefault.onMention(turn(t2, "<@UBOT> hi", "U1", { channel: "C9", ts: "2.0" }));
    const [row] = await db`select thread_id from slack_threads`;
    assert.equal((await loadTask(db, row!.thread_id as string))!.room, "inbox");
  });
});

test("an empty mention asks for a request", async () => {
  await withTestDb(async (db) => {
    await setRoom(db, "build", { slackChannel: "C1" });
    const h = await setup(db);
    const t = new StubThread("C1::1.0");
    await h.onMention(turn(t, "<@UBOT>  ", "U1", { channel: "C1", ts: "1.0" }));
    assert.equal(t.posts[0], "Mention me with what you need done.");
    assert.equal((await db`select 1 from tasks`).length, 0);
  });
});

async function mirrored(db: Db, h: Awaited<ReturnType<typeof setup>>, key = "C1::1.0") {
  const [c, ts] = key.split("::") as [string, string];
  await h.onMention(turn(new StubThread(key), "<@UBOT> do it", "U9", { channel: c, ts }));
  const [row] = await db`select thread_id from slack_threads where conversation_key = ${key}`;
  return row!.thread_id as string;
}

async function blockTask(
  db: Db,
  taskId: string,
  input: { question: string; kind: "needs_input" | "awaiting_approval"; options?: string[] },
) {
  const worker = await agentAuth(db, "worker");
  const claim = await claimNext(db, worker, { room: "build" });
  assert.ok(claim);
  await block(db, worker, taskId, claim.claimId, input);
}

test("a reply in the mirrored thread is appended to the task thread", async () => {
  await withTestDb(async (db) => {
    await setRoom(db, "build", { slackChannel: "C1" });
    const h = await setup(db);
    const taskId = await mirrored(db, h);
    await h.onMessage(turn(new StubThread("C1::1.0"), "any update?", "U9"));
    await h.onMessage(turn(new StubThread("C1::1.0"), "   ", "U9"));
    await h.onMessage(turn(new StubThread("C1::other"), "ignored", "U9"));
    const view = await getThread(db, await personAuth(db, "viewer"), taskId);
    const texts = view.messages.map((m) => String((m as { content?: unknown }).content));
    assert.ok(texts.includes("sam: any update?"));
    assert.equal(texts.filter((x) => x.includes("ignored")).length, 0);
  });
});

test("a linked person's reply answers a needs_input block with the matching option", async () => {
  await withTestDb(async (db) => {
    await setRoom(db, "build", { slackChannel: "C1" });
    await link(db, "U2", "ada");
    const h = await setup(db);
    const taskId = await mirrored(db, h);
    await blockTask(db, taskId, { question: "Which db?", kind: "needs_input", options: ["pg", "sqlite"] });
    await h.onMessage(turn(new StubThread("C1::1.0"), "PG", "U2"));
    const task = (await loadTask(db, taskId))!;
    assert.equal(task.state, "ready");
    assert.deepEqual(task.pendingResume?.[0]?.payload, { choice: "pg" });
  });
});

test("a linked person's reply answers a block with no options as text", async () => {
  await withTestDb(async (db) => {
    await setRoom(db, "build", { slackChannel: "C1" });
    await link(db, "U2", "ada");
    const h = await setup(db);
    const taskId = await mirrored(db, h);
    await blockTask(db, taskId, { question: "Why?", kind: "needs_input" });
    await h.onMessage(turn(new StubThread("C1::1.0"), "because", "U2"));
    const task = (await loadTask(db, taskId))!;
    assert.equal(task.state, "ready");
    assert.deepEqual(task.pendingResume?.[0]?.payload, { text: "because" });
  });
});

test("a linked non-approver cannot answer an approval from Slack", async () => {
  await withTestDb(async (db) => {
    await setRoom(db, "build", { slackChannel: "C1", approvers: ["ada"] });
    await link(db, "U3", "bob");
    const h = await setup(db);
    const taskId = await mirrored(db, h);
    await blockTask(db, taskId, { question: "Deploy?", kind: "awaiting_approval", options: ["approve", "reject"] });
    const thread = new StubThread("C1::1.0");
    await h.onMessage(turn(thread, "approve", "U3"));
    assert.equal(thread.ephemerals.length, 1);
    assert.match(String(thread.ephemerals[0]!.ui), /^Only a listed approver/);
    assert.equal((await loadTask(db, taskId))!.state, "blocked");
  });
});

test("an unlinked user's reply never answers a block", async () => {
  await withTestDb(async (db) => {
    await setRoom(db, "build", { slackChannel: "C1" });
    const h = await setup(db);
    const taskId = await mirrored(db, h);
    await blockTask(db, taskId, { question: "Which db?", kind: "needs_input", options: ["pg", "sqlite"] });
    await h.onMessage(turn(new StubThread("C1::1.0"), "pg", "U9"));
    assert.equal((await loadTask(db, taskId))!.state, "blocked");
  });
});

test("slackCoordinates and stripMention", () => {
  assert.deepEqual(slackCoordinates("C1::1700.1"), { channel: "C1", ts: "1700.1" });
  assert.deepEqual(slackCoordinates("opaque", { event: { channel: "C2", ts: "5.5" } }), { channel: "C2", ts: "5.5" });
  assert.deepEqual(slackCoordinates("opaque", { channel: "C3", ts: "1.1", thread_ts: "0.9" }), {
    channel: "C3",
    ts: "0.9",
  });
  assert.equal(slackCoordinates("abc"), null);
  assert.equal(stripMention("<@U123> <@U456>  hello <@U789>"), "hello <@U789>");
});

test("ensureSlackGuest is idempotent and tokenless", async () => {
  await withTestDb(async (db) => {
    const [a, b] = await Promise.all([ensureSlackGuest(db), ensureSlackGuest(db)]);
    const c = await ensureSlackGuest(db);
    assert.equal(a.actor.id, c.actor.id);
    assert.equal(b.actor.id, c.actor.id);
    assert.equal((await db`select 1 from actors where name = 'slack-guest'`).length, 1);
    assert.equal((await db`select 1 from tokens where actor_id = ${c.actor.id}`).length, 0);
    assert.deepEqual({ via: c.via, scope: c.scope, role: c.role }, { via: "system", scope: "agent", role: null });
  });
});
