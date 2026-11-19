import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TEXT_LENGTH } from "@copilotkit/teamkit-protocol";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { assertAguiValid } from "./helpers/agui.js";
import { getThread, post, reply, setLabel } from "../src/store/threads.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

test("post creates the rooms row and the thread", async () => {
  await withTestDb(async (db) => {
    const alice = await personAuth(db, "alice");
    const { threadId } = await post(db, alice, { room: "build/ui", text: "hello" });
    const rooms = await db`select name from rooms where name = 'build/ui'`;
    assert.equal(rooms.length, 1);
    const v = await getThread(db, alice, threadId);
    assert.equal(v.thread.room, "build/ui");
    assert.equal(v.thread.isTask, false);
    assert.equal(v.task, null);
    assert.equal(v.messages.length, 1);
    assert.equal((v.messages[0] as { role: string }).role, "user");
    assert.notEqual(v.cursor, "0");
  });
});

test("an agent reply is stored with role assistant and name", async () => {
  await withTestDb(async (db) => {
    const alice = await personAuth(db, "alice");
    const bot = await agentAuth(db, "bot");
    const { threadId } = await post(db, alice, { room: "build", text: "q" });
    await reply(db, bot, threadId, "answer");
    const v = await getThread(db, bot, threadId);
    const m = v.messages[1] as { role: string; name: string; content: string };
    assert.equal(m.role, "assistant");
    assert.equal(m.name, "bot");
    assert.equal(m.content, "answer");
    const ev = await db`select agui from events where kind = 'message.posted'`;
    assert.ok(!JSON.stringify(ev[0]!.agui).includes("teamkit.message.posted"));
  });
});

test("a person reply has role user and a CUSTOM teamkit.message.posted event", async () => {
  await withTestDb(async (db) => {
    const alice = await personAuth(db, "alice");
    const { threadId } = await post(db, alice, { room: "build", text: "q" });
    await reply(db, alice, threadId, "more");
    const v = await getThread(db, alice, threadId);
    assert.equal((v.messages[1] as { role: string }).role, "user");
    const ev = await db`select agui from events where kind = 'message.posted'`;
    const agui = ev[0]!.agui as { type: string; name?: string }[];
    assert.ok(agui.some((e) => e.type === "CUSTOM" && e.name === "teamkit.message.posted"));
  });
});

test("a read-only agent posting is forbidden", async () => {
  await withTestDb(async (db) => {
    const alice = await personAuth(db, "alice");
    const ro = await agentAuth(db, "ro", [{ room: "*", perms: ["read"] }]);
    await assert.rejects(post(db, ro, { room: "build", text: "x" }), code("forbidden"));
    const { threadId } = await post(db, alice, { room: "build", text: "q" });
    await assert.rejects(reply(db, ro, threadId, "x"), code("forbidden"));
    await assert.rejects(setLabel(db, ro, threadId, "k", "v"), code("forbidden"));
  });
});

test("replying or labelling an unknown thread is not_found", async () => {
  await withTestDb(async (db) => {
    const alice = await personAuth(db, "alice");
    await assert.rejects(reply(db, alice, "th_missing", "x"), code("not_found"));
    await assert.rejects(setLabel(db, alice, "th_missing", "k", "v"), code("not_found"));
    await assert.rejects(getThread(db, alice, "th_missing"), code("not_found"));
  });
});

test("text over the limit is invalid_input", async () => {
  await withTestDb(async (db) => {
    const alice = await personAuth(db, "alice");
    const big = "x".repeat(MAX_TEXT_LENGTH + 1);
    assert.equal(MAX_TEXT_LENGTH, 32000);
    await assert.rejects(post(db, alice, { room: "build", text: big }), code("invalid_input"));
    const { threadId } = await post(db, alice, { room: "build", text: "ok" });
    await assert.rejects(reply(db, alice, threadId, big), code("invalid_input"));
    await assert.rejects(post(db, alice, { room: "Bad Room", text: "x" }), code("invalid_input"));
    await assert.rejects(post(db, alice, { room: "build", text: "" }), code("invalid_input"));
  });
});

test("a label appears in getThread", async () => {
  await withTestDb(async (db) => {
    const alice = await personAuth(db, "alice");
    const { threadId } = await post(db, alice, { room: "build", text: "q" });
    await setLabel(db, alice, threadId, "prio", "high");
    await setLabel(db, alice, threadId, "area", "ui");
    const v = await getThread(db, alice, threadId);
    assert.deepEqual(v.thread.labels, { prio: "high", area: "ui" });
    await assert.rejects(setLabel(db, alice, threadId, "bad key", "v"), code("invalid_input"));
  });
});

test("an agent without read calling getThread is forbidden", async () => {
  await withTestDb(async (db) => {
    const alice = await personAuth(db, "alice");
    const noRead = await agentAuth(db, "blind", [{ room: "*", perms: ["post"] }]);
    const { threadId } = await post(db, alice, { room: "build", text: "q" });
    await assert.rejects(getThread(db, noRead, threadId), code("forbidden"));
  });
});

test("every logged event passes assertAguiValid", async () => {
  await withTestDb(async (db) => {
    const alice = await personAuth(db, "alice");
    const bot = await agentAuth(db, "bot");
    const { threadId } = await post(db, alice, { room: "build", text: "q" });
    await reply(db, bot, threadId, "a");
    await reply(db, alice, threadId, "b");
    await setLabel(db, bot, threadId, "k", "v");
    const rows = await db`select agui from events order by cursor`;
    assert.equal(rows.length, 4);
    assertAguiValid(rows.flatMap((r) => r.agui as unknown[]));
  });
});
