import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findTaskByConversation,
  getServiceCursor,
  getSlackThread,
  nativeConversationKey,
  roomForSlackChannel,
  saveSlackThread,
  setServiceCursor,
  slackRoomSettings,
} from "../src/slack/mirror.js";
import { setRoom } from "../src/store/rooms.js";
import { withTestDb } from "./helpers/db.js";
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
    assert.equal(nativeConversationKey("C1", "1.2"), "C1::1.2");
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
