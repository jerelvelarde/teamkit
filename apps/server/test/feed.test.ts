import { test } from "node:test";
import assert from "node:assert/strict";
import { custom } from "@copilotkit/teamkit-protocol";
import type { Db } from "../src/db/pool.js";
import { appendEvent } from "../src/store/events.js";
import { readEvents, validateEventQuery } from "../src/store/feed.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { withTestDb } from "./helpers/db.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

async function seed(db: Db, creatorId: string): Promise<string[]> {
  for (const room of ["build", "build/x", "secret"]) {
    await db`insert into rooms (name) values (${room})`;
  }
  await db`insert into threads (id, room, is_task, created_by) values ('th_sec', 'secret', false, ${creatorId})`;
  const cursors: string[] = [];
  for (const [room, threadId] of [
    ["build", null],
    ["secret", "th_sec"],
    ["build/x", null],
    ["secret", "th_sec"],
  ] as const) {
    const e = await db.begin((tx) =>
      appendEvent(tx, {
        kind: "message.posted",
        room,
        threadId,
        actorId: creatorId,
        agui: [custom("teamkit.test", { room })],
      }),
    );
    cursors.push(e.cursor);
  }
  return cursors;
}

test("an agent sees only readable rooms and the cursor advances past hidden events", async () => {
  await withTestDb(async (db) => {
    const person = await personAuth(db, "ada", "admin");
    const agent = await agentAuth(db, "bot", [{ room: "build/", perms: ["read"] }]);
    const [c1, , c3, c4] = await seed(db, person.actor.id);
    const all = await readEvents(db, agent, { after: "0" });
    assert.deepEqual(all.events.map((e) => e.cursor), [c1, c3]);
    assert.deepEqual(all.events.map((e) => e.room), ["build", "build/x"]);
    assert.equal(all.cursor, c4);
    const tail = await readEvents(db, agent, { after: c3 });
    assert.deepEqual(tail.events, []);
    assert.equal(tail.cursor, c4);
    const sub = await readEvents(db, agent, { room: "build/", after: "0" });
    assert.equal(sub.events.length, 2);
  });
});

test("a person sees everything", async () => {
  await withTestDb(async (db) => {
    const person = await personAuth(db, "ada", "admin");
    await seed(db, person.actor.id);
    const r = await readEvents(db, person, { after: "0" });
    assert.equal(r.events.length, 4);
    assert.equal((await readEvents(db, person, { room: "secret" })).events.length, 2);
  });
});

test("an unreadable room or thread is forbidden", async () => {
  await withTestDb(async (db) => {
    const person = await personAuth(db, "ada", "admin");
    const agent = await agentAuth(db, "bot", [{ room: "build/", perms: ["read"] }]);
    await seed(db, person.actor.id);
    await assert.rejects(readEvents(db, agent, { room: "secret" }), code("forbidden"));
    await assert.rejects(readEvents(db, agent, { thread: "th_sec" }), code("forbidden"));
  });
});

test("an admin-scope token is forbidden from every read, wildcard included", async () => {
  await withTestDb(async (db) => {
    const person = await personAuth(db, "ada", "admin");
    await seed(db, person.actor.id);
    const adminToken = { ...person, via: "token" as const, scope: "admin" as const };
    for (const q of [{}, { room: "*" }, { room: "build" }, { thread: "th_sec" }]) {
      await assert.rejects(readEvents(db, adminToken, q), code("forbidden"), JSON.stringify(q));
    }
    const adminAgent = { ...(await agentAuth(db, "ops")), scope: "admin" as const };
    await assert.rejects(readEvents(db, adminAgent, { room: "*" }), code("forbidden"));
  });
});

test("an unknown thread is not_found", async () => {
  await withTestDb(async (db) => {
    const person = await personAuth(db, "ada", "admin");
    await assert.rejects(readEvents(db, person, { thread: "th_missing" }), code("not_found"));
  });
});

test("malformed queries are invalid_input", async () => {
  await withTestDb(async (db) => {
    const person = await personAuth(db, "ada", "admin");
    await assert.rejects(readEvents(db, person, { after: "abc" }), code("invalid_input"));
    await assert.rejects(readEvents(db, person, { kinds: ["nope" as never] }), code("invalid_input"));
    await assert.rejects(readEvents(db, person, { limit: 0 }), code("invalid_input"));
    await assert.rejects(readEvents(db, person, { room: "Bad Room" }), code("invalid_input"));
  });
  for (const bad of [
    { after: "-1" },
    { after: "1".repeat(30) },
    { limit: 1001 },
    { limit: 1.5 },
    { room: "a//b" },
  ]) {
    assert.throws(() => validateEventQuery(bad), code("invalid_input"));
  }
  const ok = { after: "12", limit: 1000, room: "*", kinds: ["run.event" as const] };
  assert.equal(validateEventQuery(ok), ok);
  assert.equal(validateEventQuery({ room: "build/" }).room, "build/");
});
