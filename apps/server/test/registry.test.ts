import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { can } from "../src/store/actors.js";
import { setRoom } from "../src/store/rooms.js";
import { createTask } from "../src/store/tasks.js";
import { claimTask } from "../src/store/claims.js";
import {
  agentAuthContext,
  getAgent,
  listAgents,
  listDispatchable,
  registerAgent,
  setAgentEnabled,
  toAgentInfo,
} from "../src/dispatch/registry.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

test("a registered agent gets grants but no token, and its headers stay hidden", async () => {
  await withTestDb(async (db) => {
    const a = await registerAgent(db, {
      name: "researcher",
      url: "http://127.0.0.1:9999/agent",
      rooms: ["research"],
      headers: { Authorization: "Bearer secret", "X-Trace": "1" },
    });
    assert.equal(await can(db, a.actor, "research", "claim"), true);
    assert.equal(await can(db, a.actor, "build", "claim"), false);
    assert.equal((await db`select 1 from tokens where actor_id = ${a.actor.id}`).length, 0);
    const info = toAgentInfo(a);
    assert.deepEqual(info.headerNames, ["Authorization", "X-Trace"]);
    assert.ok(!JSON.stringify(info).includes("secret"));
    assert.deepEqual(agentAuthContext(a), { actor: a.actor, via: "system", scope: "agent", role: null });
    assert.equal((await getAgent(db, "researcher"))?.headers.Authorization, "Bearer secret");
    assert.equal((await listAgents(db)).length, 1);
  });
});

test("re-registering updates the url, rooms and grants", async () => {
  await withTestDb(async (db) => {
    const a = await registerAgent(db, { name: "researcher", url: "http://a.test/x", rooms: ["research"] });
    await setAgentEnabled(db, "researcher", false);
    const b = await registerAgent(db, { name: "researcher", url: "https://b.test/y", rooms: ["docs"] });
    assert.equal(b.actor.id, a.actor.id);
    assert.equal(b.url, "https://b.test/y");
    assert.equal(b.enabled, true);
    assert.equal(await can(db, b.actor, "research", "claim"), false);
    assert.equal(await can(db, b.actor, "docs", "claim"), true);
    assert.equal((await db`select 1 from actors where name = 'researcher'`).length, 1);
    await assert.rejects(setAgentEnabled(db, "nope", true), code("not_found"));
  });
});

test("invalid registrations are rejected", async () => {
  await withTestDb(async (db) => {
    await agentAuth(db, "taken");
    const ok = { name: "bot", url: "http://x.test", rooms: ["r"] };
    await assert.rejects(registerAgent(db, { ...ok, name: "taken" }), (e) => {
      assert.ok(code("invalid_input")(e));
      assert.match((e as Error).message, /name taken is taken/);
      return true;
    });
    await assert.rejects(registerAgent(db, { ...ok, url: "ftp://x" }), code("invalid_input"));
    await assert.rejects(registerAgent(db, { ...ok, url: "not a url" }), code("invalid_input"));
    await assert.rejects(registerAgent(db, { ...ok, name: "Bad Name" }), code("invalid_input"));
    await assert.rejects(registerAgent(db, { ...ok, rooms: [] }), code("invalid_input"));
    await assert.rejects(registerAgent(db, { ...ok, rooms: ["Bad Room"] }), code("invalid_input"));
    await assert.rejects(registerAgent(db, { ...ok, headers: { "bad header": "x" } }), code("invalid_input"));
    await assert.rejects(registerAgent(db, { ...ok, headers: { A: 1 as never } }), code("invalid_input"));
    await assert.rejects(registerAgent(db, { ...ok, headers: [] as never }), code("invalid_input"));
    await assert.rejects(registerAgent(db, { ...ok, ownerId: "ac_nope" }), code("invalid_input"));
    assert.equal((await db`select 1 from actors where name = 'bot'`).length, 0);
  });
});

test("listDispatchable routes by room agent or agent label, enabled agents only", async () => {
  await withTestDb(async (db) => {
    const ann = await personAuth(db, "ann");
    await registerAgent(db, { name: "researcher", url: "http://r.test", rooms: ["research", "misc"] });
    await registerAgent(db, { name: "builder", url: "http://b.test", rooms: ["build"] });
    await setRoom(db, "research", { agent: "researcher" });
    await setRoom(db, "build", { agent: "builder" });
    await setRoom(db, "misc", {});
    const t1 = await createTask(db, ann, { room: "research", brief: "one" });
    const t2 = await createTask(db, ann, { room: "misc", brief: "two", labels: { agent: "researcher" } });
    const t3 = await createTask(db, ann, { room: "build", brief: "three" });
    await createTask(db, ann, { room: "misc", brief: "unrouted" });

    let list = await listDispatchable(db, 10);
    assert.deepEqual(list.map((x) => x.taskId), [t1.id, t2.id, t3.id]);
    assert.deepEqual(list.map((x) => x.agent.name), ["researcher", "researcher", "builder"]);
    assert.equal((await listDispatchable(db, 2)).length, 2);

    await setAgentEnabled(db, "builder", false);
    list = await listDispatchable(db, 10);
    assert.deepEqual(list.map((x) => x.taskId), [t1.id, t2.id]);

    const researcher = agentAuthContext((await getAgent(db, "researcher"))!);
    await claimTask(db, researcher, t1.id);
    list = await listDispatchable(db, 10);
    assert.deepEqual(list.map((x) => x.taskId), [t2.id]);
  });
});
