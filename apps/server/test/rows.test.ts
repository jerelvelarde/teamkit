import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageSchema } from "@ag-ui/core/schemas";
import { withTestDb } from "./helpers/db.js";
import {
  appendMessage,
  assertText,
  ensureRoom,
  insertThread,
  loadThreadInfo,
  messageFor,
  validateLabels,
} from "../src/store/rows.js";

const bad = { code: "invalid_input" };

test("ensureRoom validates and is idempotent", async () => {
  await withTestDb(async (db) => {
    await assert.rejects(ensureRoom(db, "Bad"), bad);
    await ensureRoom(db, "eng/web");
    await ensureRoom(db, "eng/web");
    const rows = await db`select name from rooms`;
    assert.equal(rows.length, 1);
  });
});

test("insertThread then loadThreadInfo", async () => {
  await withTestDb(async (db) => {
    await db`insert into actors (id, kind, name) values ('ac_1', 'agent', 'bot')`;
    await ensureRoom(db, "eng");
    await insertThread(db, { id: "th_1", room: "eng", isTask: true, labels: { a: "b" }, createdBy: "ac_1" });
    const info = await loadThreadInfo(db, "th_1");
    assert.ok(info);
    assert.deepEqual(
      { ...info, createdAt: undefined },
      {
        id: "th_1",
        room: "eng",
        isTask: true,
        labels: { a: "b" },
        createdBy: { id: "ac_1", name: "bot", kind: "agent" },
        createdAt: undefined,
      },
    );
    assert.equal(new Date(info.createdAt).toISOString(), info.createdAt);
    assert.equal(await loadThreadInfo(db, "th_nope"), null);
  });
});

test("appendMessage assigns increasing seq", async () => {
  await withTestDb(async (db) => {
    await db`insert into actors (id, kind, name) values ('ac_1', 'person', 'pat')`;
    await ensureRoom(db, "eng");
    await insertThread(db, { id: "th_1", room: "eng", isTask: false, labels: {}, createdBy: "ac_1" });
    const actor = { id: "ac_1", name: "pat", kind: "person" as const };
    const append = (id: string) =>
      db.begin((tx) => appendMessage(tx, "th_1", messageFor({ messageId: id, role: "user", text: id, actor })));
    assert.equal(await append("m1"), 1);
    assert.equal(await append("m2"), 2);
  });
});

test("concurrent appendMessage transactions on one thread get distinct sequential seqs", async () => {
  await withTestDb(async (db) => {
    await db`insert into actors (id, kind, name) values ('ac_1', 'person', 'pat')`;
    await ensureRoom(db, "eng");
    await insertThread(db, { id: "th_1", room: "eng", isTask: false, labels: {}, createdBy: "ac_1" });
    const actor = { id: "ac_1", name: "pat", kind: "person" as const };
    const seqs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db.begin((tx) =>
          appendMessage(tx, "th_1", messageFor({ messageId: `m${i}`, role: "user", text: `${i}`, actor })),
        ),
      ),
    );
    assert.deepEqual(
      [...seqs].sort((x, y) => x - y),
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    const rows = await db<{ seq: number }[]>`select seq from messages where thread_id = 'th_1' order by seq`;
    assert.deepEqual(
      rows.map((r) => r.seq),
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });
});

test("messageFor passes MessageSchema", () => {
  const m = messageFor({
    messageId: "m1",
    role: "assistant",
    text: "hi",
    actor: { id: "ac_1", name: "bot", kind: "agent" },
  });
  assert.equal(MessageSchema.safeParse(m).success, true);
  assert.equal((m as { name?: string }).name, "bot");
});

test("assertText", () => {
  assert.throws(() => assertText("brief", "x".repeat(32_001)), bad);
  assert.throws(() => assertText("brief", "", { required: true }), bad);
  assert.throws(() => assertText("brief", undefined, { required: true }), bad);
  assert.throws(() => assertText("brief", 5), bad);
  assert.equal(assertText("brief", undefined), undefined);
  assert.equal(assertText("brief", "ok", { required: true }), "ok");
  assert.throws(() => assertText("brief", "a\u0000b"), bad);
  assert.throws(() => assertText("brief", "\u0000", { required: true }), bad);
});

test("validateLabels", () => {
  assert.deepEqual(validateLabels(undefined), {});
  assert.deepEqual(validateLabels({ "a.b-c_1": "v" }), { "a.b-c_1": "v" });
  assert.throws(() => validateLabels({ "bad key": "v" }), bad);
  assert.throws(() => validateLabels({ a: 1 }), bad);
  assert.throws(() => validateLabels({ a: "x".repeat(1001) }), bad);
  assert.throws(() => validateLabels([]), bad);
  assert.throws(() => validateLabels(null), bad);
  assert.throws(() => validateLabels({ a: "x\u0000y" }), bad);
  assert.throws(() => validateLabels({ "a\u0000": "v" }), bad);
});
