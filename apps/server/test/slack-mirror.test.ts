import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findTaskByConversation,
  findTaskByCoordinates,
  getServiceCursor,
  getSlackPost,
  getSlackThread,
  getStatusMessage,
  linkedRooms,
  roomForSlackChannel,
  saveSlackPost,
  saveStatusMessage,
  saveSlackThread,
  setServiceCursor,
  slackRoomSettings,
  slackUserOf,
} from "../src/slack/mirror.js";
import { setRoom } from "../src/store/rooms.js";
import { withTestDb } from "./helpers/db.js";
import { CHANNEL, SLACK_USER, seedBilling } from "./helpers/billing.js";
import { agentAuth } from "./helpers/actors.js";

test("saveSlackThread keeps columns a later save leaves null", async () => {
  await withTestDb(async (db) => {
    const a = await agentAuth(db, "bot");
    await setRoom(db, "build", {});
    await db`insert into threads (id, room, is_task, created_by) values ('thr_1', 'build', true, ${a.actor.id})`;
    assert.equal(await getSlackThread(db, "thr_1"), null);
    await saveSlackThread(db, { taskId: "thr_1", channel: null, ts: null, conversationKey: "K1" });
    const row = await saveSlackThread(db, { taskId: "thr_1", channel: "C1", ts: "1.2", conversationKey: null });
    assert.deepEqual(row, { taskId: "thr_1", channel: "C1", ts: "1.2", conversationKey: "K1" });
    assert.deepEqual(await getSlackThread(db, "thr_1"), row);
    assert.equal(await findTaskByConversation(db, "K1"), "thr_1");
    assert.equal(await findTaskByConversation(db, "nope"), null);
  });
});

test("findTaskByCoordinates fills in a missing conversation key and never replaces one", async () => {
  await withTestDb(async (db) => {
    const a = await agentAuth(db, "bot");
    await setRoom(db, "build", {});
    for (const id of ["thr_1", "thr_2"]) {
      await db`insert into threads (id, room, is_task, created_by) values (${id}, 'build', true, ${a.actor.id})`;
    }
    // thr_1: a thread Slack outbound started (no key yet). thr_2: a mention's thread, key stored.
    await saveSlackThread(db, { taskId: "thr_1", channel: "C1", ts: "1.0", conversationKey: null });
    await saveSlackThread(db, { taskId: "thr_2", channel: "C1", ts: "2.0", conversationKey: "cth_mention" });

    assert.equal(await findTaskByCoordinates(db, { channel: "C1", ts: "1.0" }, "cth_card"), "thr_1");
    assert.equal((await getSlackThread(db, "thr_1"))?.conversationKey, "cth_card");
    assert.equal(await findTaskByConversation(db, "cth_card"), "thr_1");

    assert.equal(await findTaskByCoordinates(db, { channel: "C1", ts: "2.0" }, "cth_other"), "thr_2");
    assert.equal((await getSlackThread(db, "thr_2"))?.conversationKey, "cth_mention");
    assert.equal(await findTaskByCoordinates(db, { channel: "C1", ts: "9.9" }, "cth_x"), null);

    // A later save with no key (Slack outbound) keeps the stored one.
    await saveSlackThread(db, { taskId: "thr_2", channel: "C1", ts: "2.0", conversationKey: null });
    assert.equal((await getSlackThread(db, "thr_2"))?.conversationKey, "cth_mention");
  });
});

test("roomForSlackChannel and slackRoomSettings read the room columns", async () => {
  await withTestDb(async (db) => {
    await setRoom(db, "zeta", { slackChannel: "C1" });
    await setRoom(db, "build", { slackChannel: "C1", slackAnnounce: "all" });
    assert.equal(await roomForSlackChannel(db, "C1"), "build");
    assert.equal(await roomForSlackChannel(db, "C9"), null);
    assert.deepEqual(await slackRoomSettings(db, "build"), { channel: "C1", announce: "all" });
    assert.deepEqual(await slackRoomSettings(db, "zeta"), { channel: "C1", announce: "blocked" });
    assert.deepEqual(await slackRoomSettings(db, "missing"), { channel: null, announce: "blocked" });
  });
});

test("service cursors only move forward", async () => {
  await withTestDb(async (db) => {
    assert.equal(await getServiceCursor(db, "slack-outbound"), null);
    await setServiceCursor(db, "slack-outbound", "10");
    await setServiceCursor(db, "slack-outbound", "5");
    assert.equal(await getServiceCursor(db, "slack-outbound"), "10");
    await setServiceCursor(db, "slack-outbound", "11");
    assert.equal(await getServiceCursor(db, "slack-outbound"), "11");
  });
});

test("status message rows upsert by room and keep edited_at to the millisecond", async () => {
  await withTestDb(async (db) => {
    await seedBilling(db, { linkSlack: false });
    assert.equal(await getStatusMessage(db, "billing-migration"), null);
    const row = { room: "billing-migration", channel: CHANNEL.migration, ts: "1.000", pinned: true, bodyHash: "h1", editedAt: 1_763_560_000_123 };
    await saveStatusMessage(db, row);
    await saveStatusMessage(db, { ...row, bodyHash: "h2", editedAt: row.editedAt + 10_000 });
    assert.deepEqual(await getStatusMessage(db, "billing-migration"), { ...row, bodyHash: "h2", editedAt: row.editedAt + 10_000 });
  });
});

test("a decision's or alert's Slack post is kept by id, and loud never goes back", async () => {
  await withTestDb(async (db) => {
    await saveSlackPost(db, { kind: "alert", refId: "alr_1", channel: CHANNEL.prod, ts: "3.000", loud: true });
    await saveSlackPost(db, { kind: "alert", refId: "alr_1", channel: CHANNEL.prod, ts: "3.000", loud: false });
    assert.equal((await getSlackPost(db, "alert", "alr_1"))?.loud, true);
    assert.equal(await getSlackPost(db, "decision", "alr_1"), null);
  });
});

test("linkedRooms lists rooms that post to a channel, by name, with their approvers", async () => {
  await withTestDb(async (db) => {
    await seedBilling(db, { linkSlack: false });
    assert.deepEqual(await linkedRooms(db), [
      { room: "billing-migration", channel: CHANNEL.migration, announce: "blocked", approvers: null },
      { room: "billing-prod", channel: CHANNEL.prod, announce: "blocked", approvers: ["sam"] },
    ]);
    await setRoom(db, "billing-migration", { slackAnnounce: "none" });
    await setRoom(db, "billing-prod", { slackChannel: null });
    assert.deepEqual(await linkedRooms(db), []);
  });
});

test("slackUserOf finds a person's linked Slack user, or null", async () => {
  await withTestDb(async (db) => {
    await seedBilling(db);
    assert.equal(await slackUserOf(db, "sam"), SLACK_USER.sam);
    assert.equal(await slackUserOf(db, "ben-agent"), null);
    assert.equal(await slackUserOf(db, "nobody"), null);
  });
});
