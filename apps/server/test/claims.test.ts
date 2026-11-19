import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { assertAguiValid } from "./helpers/agui.js";
import { agentAuthContext, registerAgent, setAgentEnabled } from "../src/dispatch/registry.js";
import { answer, block } from "../src/store/blocks.js";
import { setRoom } from "../src/store/rooms.js";
import { createTask } from "../src/store/tasks.js";
import { claimNext, claimTask, complete, fail, leaseMs, release, renew } from "../src/store/claims.js";
import { listEvents } from "../src/store/events.js";
import { loadTask } from "../src/store/task-load.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
const routedTo = (agent: string) => (e: unknown) =>
  code("forbidden")(e) && (e as Error).message.endsWith(`is routed to agent ${agent}`);

test("20 concurrent claimTask on one task: exactly one wins", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const t = await createTask(db, bot, { room: "build", brief: "x" });
    const workers = await Promise.all(Array.from({ length: 20 }, (_, i) => agentAuth(db, `w${i}`)));
    const results = await Promise.allSettled(workers.map((w) => claimTask(db, w, t.id)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(ok.length, 1);
    assert.equal(bad.length, 19);
    for (const r of bad) assert.equal((r.reason as { code?: string }).code, "task_claimed");
    const { events } = await listEvents(db, { kinds: ["task.claimed"] });
    assert.equal(events.length, 1);
  });
});

test("10 workers over 10 tasks: each task claimed once", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    for (let i = 0; i < 10; i++) await createTask(db, bot, { room: "build", brief: `t${i}` });
    const workers = await Promise.all(Array.from({ length: 10 }, (_, i) => agentAuth(db, `w${i}`)));
    const claims = await Promise.all(workers.map((w) => claimNext(db, w, { room: "*" })));
    const ids = claims.map((c) => c?.task.id);
    assert.ok(ids.every((id) => typeof id === "string"));
    assert.equal(new Set(ids).size, 10);
    assert.equal(await claimNext(db, bot, { room: "*" }), null);
  });
});

test("claimNext honours room, labels and order", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const a = await createTask(db, bot, { room: "build/x", brief: "a", labels: { k: "1" } });
    const b = await createTask(db, bot, { room: "ops", brief: "b" });
    const c = await createTask(db, bot, { room: "build", brief: "c", labels: { k: "1" } });
    assert.equal((await claimNext(db, bot, { room: "ops" }))!.task.id, b.id);
    assert.equal((await claimNext(db, bot, { room: "build/", labels: { k: "1" } }))!.task.id, a.id);
    assert.equal((await claimNext(db, bot, { room: "build/", labels: { k: "2" } })), null);
    assert.equal((await claimNext(db, bot, { room: "build" }))!.task.id, c.id);
  });
});

test("without a claim grant: claimNext is null, claimTask is forbidden", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const t = await createTask(db, bot, { room: "build", brief: "x" });
    const ro = await agentAuth(db, "ro", [{ room: "*", perms: ["read", "post"] }]);
    assert.equal(await claimNext(db, ro, { room: "*" }), null);
    await assert.rejects(claimTask(db, ro, t.id), code("forbidden"));
    await assert.rejects(claimTask(db, bot, "th_nope"), code("not_found"));
  });
});

test("claimNext refuses an admin-scope token, a person's included", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const t = await createTask(db, bot, { room: "build", brief: "x" });
    const p = await personAuth(db, "ada", "admin");
    const adminPerson = { ...p, via: "token" as const, scope: "admin" as const };
    const adminAgent = { ...(await agentAuth(db, "ops")), scope: "admin" as const };
    for (const auth of [adminPerson, adminAgent]) {
      await assert.rejects(claimNext(db, auth, { room: "*" }), code("forbidden"));
    }
    assert.equal((await loadTask(db, t.id))!.state, "ready");
    assert.equal((await claimNext(db, p, { room: "*" }))?.task.id, t.id);
  });
});

test("a lapsed claim: the old holder gets claim_lost on renew, complete and release", async () => {
  await withTestDb(async (db) => {
    const a = await agentAuth(db, "a");
    const b = await agentAuth(db, "b");
    const t = await createTask(db, a, { room: "build", brief: "x" });
    const first = await claimTask(db, a, t.id);
    await db`update tasks set state='ready', claim_id=null, claimed_by=null, lease_expires_at=null where thread_id=${t.id}`;
    // Not claimed at all: already claim_lost.
    await assert.rejects(renew(db, a, t.id, first.claimId), code("claim_lost"));
    const second = await claimTask(db, b, t.id);
    await assert.rejects(renew(db, a, t.id, first.claimId), code("claim_lost"));
    await assert.rejects(complete(db, a, t.id, first.claimId, "done"), code("claim_lost"));
    await assert.rejects(release(db, a, t.id, first.claimId), code("claim_lost"));
    await assert.rejects(fail(db, a, t.id, first.claimId, "no"), code("claim_lost"));
    // Right claim id, wrong actor.
    await assert.rejects(renew(db, a, t.id, second.claimId), code("claim_lost"));
    await assert.rejects(renew(db, b, "th_nope", second.claimId), code("not_found"));
    const done = await complete(db, b, t.id, second.claimId, "ok");
    assert.equal(done.state, "completed");
    assert.equal(done.result, "ok");
    assert.equal(done.claim, null);
  });
});

test("TEAMKIT_LEASE_MS is honoured; renew extends; release returns to ready", async () => {
  const prev = process.env.TEAMKIT_LEASE_MS;
  process.env.TEAMKIT_LEASE_MS = "7000";
  try {
    assert.equal(leaseMs(), 7000);
    await withTestDb(async (db) => {
      const bot = await agentAuth(db, "bot");
      const t = await createTask(db, bot, { room: "build", brief: "x" });
      const before = Date.now();
      const c = await claimTask(db, bot, t.id);
      const exp = Date.parse(c.leaseExpiresAt);
      assert.ok(Math.abs(exp - (before + 7000)) < 3000, `lease ${exp - before}ms`);
      process.env.TEAMKIT_LEASE_MS = "20000";
      const r = await renew(db, bot, t.id, c.claimId);
      assert.ok(Date.parse(r.leaseExpiresAt) > exp + 5000);
      const rel = await release(db, bot, t.id, c.claimId);
      assert.equal(rel.state, "ready");
      assert.equal(rel.claim, null);
      await assert.rejects(release(db, bot, t.id, c.claimId), code("claim_lost"));
    });
  } finally {
    if (prev === undefined) delete process.env.TEAMKIT_LEASE_MS;
    else process.env.TEAMKIT_LEASE_MS = prev;
  }
});

test("claim on a non-ready task is invalid_state; fail needs a reason", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const a = await createTask(db, bot, { room: "build", brief: "a" });
    const b = await createTask(db, bot, { room: "build", brief: "b", needs: [a.id] });
    await assert.rejects(claimTask(db, bot, b.id), code("invalid_state"));
    const c = await claimTask(db, bot, a.id);
    await assert.rejects(fail(db, bot, a.id, c.claimId, ""), code("invalid_input"));
    const f = await fail(db, bot, a.id, c.claimId, "broke");
    assert.equal(f.state, "failed");
    await assert.rejects(claimTask(db, bot, a.id), code("invalid_state"));
  });
});

test("all claim events are valid AG-UI and carry taskId and state", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const t = await createTask(db, bot, { room: "build", brief: "x" });
    const c1 = await claimTask(db, bot, t.id);
    await release(db, bot, t.id, c1.claimId);
    const c2 = await claimTask(db, bot, t.id, { opensRun: false });
    await complete(db, bot, t.id, c2.claimId, null);
    const u = await createTask(db, bot, { room: "build", brief: "y" });
    const c3 = await claimTask(db, bot, u.id);
    await fail(db, bot, u.id, c3.claimId, "nope");
    const { events } = await listEvents(db, {});
    const kinds = events.map((e) => e.kind);
    for (const k of ["task.claimed", "task.released", "task.completed", "task.failed"]) assert.ok(kinds.includes(k as never));
    for (const e of events) {
      assertAguiValid(e.agui);
      if (e.kind.startsWith("task.")) {
        assert.equal(e.data.taskId, e.threadId);
        assert.equal(typeof e.data.state, "string");
      }
    }
    const second = events.filter((e) => e.kind === "task.claimed")[1]!;
    assert.equal(second.agui.length, 1);
  });
});

test("a task routed to a registered agent is that agent's alone: label, then target, then room agent", async () => {
  await withTestDb(async (db) => {
    const worker = await agentAuth(db, "worker");
    const svc = agentAuthContext(await registerAgent(db, { name: "svc", url: "http://127.0.0.1:9/svc", rooms: ["build", "ops"] }));
    const roomAgent = agentAuthContext(await registerAgent(db, { name: "ops-agent", url: "http://127.0.0.1:9/ops", rooms: ["ops"] }));
    await setRoom(db, "ops", { agent: "ops-agent" });

    const byLabel = await createTask(db, worker, { room: "build", brief: "label", labels: { agent: "svc" } });
    const byTarget = await createTask(db, worker, { room: "build", brief: "target", target: "svc" });
    const byRoom = await createTask(db, worker, { room: "ops", brief: "room agent" });
    const labelOverRoom = await createTask(db, worker, { room: "ops", brief: "label wins", labels: { agent: "svc" } });
    const targetOverRoom = await createTask(db, worker, { room: "ops", brief: "target wins", target: "svc" });
    const notAnAgent = await createTask(db, worker, { room: "build", brief: "free", target: "someone" });
    const unknownLabel = await createTask(db, worker, { room: "build", brief: "free too", labels: { agent: "gone" } });

    // A CLI worker gets only the tasks no registered agent owns.
    const got = [];
    for (let c; (c = await claimNext(db, worker, { room: "*" })); ) got.push(c.task.id);
    assert.deepEqual(got, [notAnAgent.id, unknownLabel.id]);
    await assert.rejects(claimTask(db, worker, byLabel.id), routedTo("svc"));
    await assert.rejects(claimTask(db, worker, byTarget.id), routedTo("svc"));
    await assert.rejects(claimTask(db, worker, byRoom.id), routedTo("ops-agent"));
    await assert.rejects(claimTask(db, roomAgent, labelOverRoom.id), routedTo("svc"));
    await assert.rejects(claimTask(db, roomAgent, targetOverRoom.id), routedTo("svc"));

    // Each agent claims its own, and only its own.
    assert.equal((await claimNext(db, roomAgent, { room: "*" }))?.task.id, byRoom.id);
    assert.equal(await claimNext(db, roomAgent, { room: "*" }), null);
    assert.equal((await claimTask(db, svc, byTarget.id)).task.id, byTarget.id);
    assert.equal((await claimNext(db, svc, { room: "*" }))?.task.id, byLabel.id);

    // A disabled agent owns nothing: its tasks are anyone's again.
    await setAgentEnabled(db, "svc", false);
    assert.equal((await claimNext(db, worker, { room: "*" }))?.task.id, labelOverRoom.id);
    assert.equal((await claimTask(db, roomAgent, targetOverRoom.id)).task.id, targetOverRoom.id, "the room agent again");
  });
});

test("an answered approval waiting to resume stays with its agent", async () => {
  await withTestDb(async (db) => {
    const worker = await agentAuth(db, "worker");
    const ada = await personAuth(db, "ada", "admin");
    const svc = agentAuthContext(await registerAgent(db, { name: "svc", url: "http://127.0.0.1:9/svc", rooms: ["build"] }));
    await setRoom(db, "build", { agent: "svc" });
    const t = await createTask(db, worker, { room: "build", brief: "ship it" });
    const c = await claimTask(db, svc, t.id);
    await block(db, svc, t.id, c.claimId, { question: "Ship?", kind: "awaiting_approval" });
    await answer(db, ada, t.id, { text: "yes" });
    assert.ok((await loadTask(db, t.id))!.pendingResume);

    assert.equal(await claimNext(db, worker, { room: "*" }), null);
    await assert.rejects(claimTask(db, worker, t.id), routedTo("svc"));
    assert.equal((await claimNext(db, svc, { room: "build" }))?.task.id, t.id);
  });
});
