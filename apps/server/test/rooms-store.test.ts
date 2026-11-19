import { test } from "node:test";
import assert from "node:assert/strict";
import { custom } from "@copilotkit/teamkit-protocol";
import type { Db } from "../src/db/pool.js";
import { appendEvent } from "../src/store/events.js";
import { getRoom, getRoomInfo, listRooms, setRoom } from "../src/store/rooms.js";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

async function addThread(db: Db, id: string, room: string, by: string, task?: { state: string; brief: string }) {
  await db`insert into threads (id, room, is_task, created_by) values (${id}, ${room}, ${task !== undefined}, ${by})`;
  if (task) await db`insert into tasks (thread_id, state, brief) values (${id}, ${task.state}, ${task.brief})`;
  return db.begin((tx) =>
    appendEvent(tx, {
      kind: "message.posted",
      room,
      threadId: id,
      actorId: by,
      agui: [custom("teamkit.test", {})],
    }),
  );
}

test("setRoom creates, then updates, and getRoomInfo reflects it", async () => {
  await withTestDb(async (db) => {
    assert.equal(await getRoomInfo(db, "build"), null);
    const a = await setRoom(db, "build", { agent: "worker", approvers: ["ada"], slackAnnounce: "all" });
    assert.equal(a.agent, "worker");
    assert.deepEqual(a.approvers, ["ada"]);
    assert.equal(a.slackAnnounce, "all");
    assert.equal(a.slackChannel, null);
    const b = await setRoom(db, "build", { slackChannel: "C1", approvers: null });
    assert.equal(b.agent, "worker");
    assert.equal(b.approvers, null);
    assert.equal(b.slackChannel, "C1");
    assert.equal(b.slackAnnounce, "all");
    assert.deepEqual(await getRoomInfo(db, "build"), b);
    await assert.rejects(setRoom(db, "Bad Name", {}), code("invalid_input"));
    await assert.rejects(setRoom(db, "build", { approvers: [""] }), code("invalid_input"));
    await assert.rejects(setRoom(db, "build", { slackAnnounce: "x" as never }), code("invalid_input"));
  });
});

test("getRoom lists thread summaries with task state, and after narrows them", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada", "admin");
    await setRoom(db, "build", {});
    const e1 = await addThread(db, "th_1", "build", ada.actor.id, { state: "ready", brief: "do it" });
    await new Promise((r) => setTimeout(r, 5));
    await addThread(db, "th_2", "build", ada.actor.id);
    await setRoom(db, "other", {});
    await addThread(db, "th_3", "other", ada.actor.id);
    const all = await getRoom(db, ada, "build");
    assert.deepEqual(all.threads.map((t) => t.id), ["th_1", "th_2"]);
    assert.equal(all.threads[0]!.state, "ready");
    assert.equal(all.threads[0]!.brief, "do it");
    assert.equal(all.threads[1]!.state, null);
    assert.equal(all.threads[1]!.brief, null);
    assert.equal(all.threads[0]!.createdBy.name, "ada");
    const later = await getRoom(db, ada, "build", { after: e1.cursor });
    assert.deepEqual(later.threads.map((t) => t.id), ["th_2"]);
    assert.ok(BigInt(later.cursor) >= BigInt(e1.cursor));
  });
});

test("a malformed after is invalid_input", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada");
    await setRoom(db, "build", {});
    for (const after of ["abc", "", "-1", "1.5", "1e3", "9223372036854775808"]) {
      await assert.rejects(getRoom(db, ada, "build", { after }), code("invalid_input"), `after=${after}`);
    }
    assert.deepEqual((await getRoom(db, ada, "build", { after: "9223372036854775807" })).threads, []);
  });
});

test("an unknown room is not_found", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada");
    await assert.rejects(getRoom(db, ada, "nope"), code("not_found"));
  });
});

test("an agent sees only rooms it has a grant for", async () => {
  await withTestDb(async (db) => {
    for (const r of ["alpha", "beta", "team/x"]) await setRoom(db, r, {});
    const bot = await agentAuth(db, "bot", [
      { room: "alpha", perms: ["read"] },
      { room: "team/", perms: ["read"] },
      { room: "beta", perms: ["post"] },
    ]);
    assert.deepEqual((await listRooms(db, bot)).map((r) => r.name), ["alpha", "team/x"]);
    await assert.rejects(getRoom(db, bot, "beta"), code("forbidden"));
    const ada = await personAuth(db, "ada");
    assert.deepEqual((await listRooms(db, ada)).map((r) => r.name), ["alpha", "beta", "team/x"]);
  });
});

test("an admin-scope token cannot list rooms, but the person's session can", async () => {
  await withTestDb(async (db) => {
    await setRoom(db, "build", {});
    const p = await personAuth(db, "ann", "admin");
    await assert.rejects(
      listRooms(db, { ...p, via: "token", scope: "admin" }),
      (e) =>
        (e as { code?: string }).code === "forbidden" &&
        (e as Error).message === "ann uses an admin token, which cannot list rooms",
    );
    assert.deepEqual((await listRooms(db, p)).map((r) => r.name), ["build"]);
  });
});

test("a new room holds for 30 minutes by default", async () => {
  await withTestDb(async (db) => {
    assert.equal((await setRoom(db, "billing-migration", {})).reservationMinutes, 30);
  });
});
