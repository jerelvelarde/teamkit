import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { custom, runFinishedSuccess, runStarted, type AguiEvent } from "@copilotkit/teamkit-protocol";
import type { Db } from "../src/db/pool.js";
import { appendEvent, listEvents } from "../src/store/events.js";
import { reapExpired } from "../src/store/reaper.js";
import { assertAguiValid } from "./helpers/agui.js";
import { withTestDb } from "./helpers/db.js";

const MIN = 60_000;

async function seed(db: Db): Promise<void> {
  await db`insert into actors (id, kind, name, role) values ('pe_ada', 'person', 'ada', 'admin')`;
  await db`insert into actors (id, kind, name, owner_id) values ('ag_w1', 'agent', 'worker-1', 'pe_ada'), ('ag_w2', 'agent', 'worker-2', 'pe_ada')`;
  await db`insert into rooms (name) values ('build'), ('build/x')`;
  for (const [id, room] of [["t1", "build"], ["t2", "build/x"], ["t3", "build"], ["t4", "build"]] as const) {
    await db`insert into threads (id, room, is_task, created_by) values (${id}, ${room}, true, 'pe_ada')`;
  }
}

async function claimed(db: Db, id: string, holder: string, claimId: string, lease: Date): Promise<void> {
  await db`insert into tasks (thread_id, state, brief, claim_id, claimed_by, lease_expires_at)
           values (${id}, 'claimed', 'b', ${claimId}, ${holder}, ${lease})`;
}

/** Logs events for a claim the way a claim and its run would: data.claimId names the claim. */
async function logged(db: Db, id: string, holder: string, claimId: string, kind: "task.claimed" | "run.event", agui: AguiEvent[]) {
  await db.begin((tx) => appendEvent(tx, { kind, room: "build", threadId: id, actorId: holder, agui, data: { claimId } }));
}

test("reapExpired returns a lapsed claim to ready and logs lease_expired", async () => {
  await withTestDb(async (db) => {
    await seed(db);
    const now = new Date();
    await claimed(db, "t1", "ag_w1", "cl_1", new Date(now.getTime() + 5 * MIN));
    // A claim taken with opensRun starts a run in its task.claimed event.
    await logged(db, "t1", "ag_w1", "cl_1", "task.claimed", [
      custom("teamkit.task.claimed", { claimId: "cl_1" }),
      runStarted("t1", "cl_1", "cl_1"),
    ]);

    assert.equal(await reapExpired(db, now), 0);
    assert.equal((await listEvents(db, { kinds: ["task.lease_expired"] })).events.length, 0);

    assert.equal(await reapExpired(db, new Date(now.getTime() + 6 * MIN)), 1);
    const [t] = await db`select state, claim_id, claimed_by, lease_expires_at from tasks where thread_id = 't1'`;
    assert.deepEqual({ ...t }, { state: "ready", claim_id: null, claimed_by: null, lease_expires_at: null });

    const { events } = await listEvents(db, { kinds: ["task.lease_expired"] });
    assert.equal(events.length, 1);
    const e = events[0]!;
    assert.equal(e.kind, "task.lease_expired");
    assert.equal(e.room, "build");
    assert.equal(e.threadId, "t1");
    assert.deepEqual(e.actor, { id: "ag_w1", name: "worker-1", kind: "agent" });
    assert.deepEqual(e.data, { taskId: "t1", state: "ready", claimId: "cl_1" });
    assert.equal(e.agui.length, 1);
    assert.equal(e.agui[0]!.type, "RUN_ERROR");
    assert.equal((e.agui[0] as { code?: string }).code, "teamkit.lease_expired");
    assertAguiValid(e.agui);

    assert.equal(await reapExpired(db, new Date(now.getTime() + 7 * MIN)), 0);
    assert.equal((await listEvents(db, { kinds: ["task.lease_expired"] })).events.length, 1);
  });
});

test("a lapsed claim whose run is closed or never started gets a lease_expired CUSTOM, not a RUN_ERROR", async () => {
  await withTestDb(async (db) => {
    await seed(db);
    const past = new Date(Date.now() - MIN);
    // t1: a dispatcher claim whose agent run finished (between board tool rounds).
    await claimed(db, "t1", "ag_w1", "cl_1", past);
    await logged(db, "t1", "ag_w1", "cl_1", "task.claimed", [custom("teamkit.task.claimed", { claimId: "cl_1" })]);
    await logged(db, "t1", "ag_w1", "cl_1", "run.event", [runStarted("t1", "run_1", "cl_1")]);
    await logged(db, "t1", "ag_w1", "cl_1", "run.event", [runFinishedSuccess("t1", "run_1", null)]);
    // t3: a dispatcher claim whose agent never answered.
    await claimed(db, "t3", "ag_w1", "cl_3", past);
    await logged(db, "t3", "ag_w1", "cl_3", "task.claimed", [custom("teamkit.task.claimed", { claimId: "cl_3" })]);
    // t4: an earlier claim's run is still open in the log, but it is not this claim's.
    await claimed(db, "t4", "ag_w2", "cl_4b", past);
    await logged(db, "t4", "ag_w2", "cl_4a", "run.event", [runStarted("t4", "run_4", "cl_4a")]);
    // t2: this claim's run is open.
    await claimed(db, "t2", "ag_w2", "cl_2", past);
    await logged(db, "t2", "ag_w2", "cl_2", "run.event", [runStarted("t2", "run_2", "cl_2")]);

    assert.equal(await reapExpired(db), 4);
    const { events } = await listEvents(db, { kinds: ["task.lease_expired"] });
    assert.deepEqual(
      events.map((e) => [e.threadId, e.agui.map((a) => (a.type === "CUSTOM" ? `CUSTOM ${String(a.name)}` : a.type))]),
      [
        ["t1", ["CUSTOM teamkit.task.lease_expired"]],
        ["t2", ["RUN_ERROR"]],
        ["t3", ["CUSTOM teamkit.task.lease_expired"]],
        ["t4", ["CUSTOM teamkit.task.lease_expired"]],
      ],
    );
    assert.deepEqual(events[0]!.agui[0], { type: "CUSTOM", name: "teamkit.task.lease_expired", value: { claimId: "cl_1" } });
    for (const e of events) assertAguiValid(e.agui);
  });
});

test("two expired tasks give two events, each in its own room", async () => {
  await withTestDb(async (db) => {
    await seed(db);
    const past = new Date(Date.now() - MIN);
    await claimed(db, "t1", "ag_w1", "cl_1", past);
    await claimed(db, "t2", "ag_w2", "cl_2", past);
    assert.equal(await reapExpired(db), 2);
    const { events } = await listEvents(db, {});
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => [e.threadId, e.room, e.actor?.id, e.data.claimId]),
      [["t1", "build", "ag_w1", "cl_1"], ["t2", "build/x", "ag_w2", "cl_2"]],
    );
    for (const e of events) assertAguiValid(e.agui);
  });
});

test("skip locked: a task held by another transaction is left for the next reap", async () => {
  await withTestDb(async (db) => {
    await seed(db);
    const past = new Date(Date.now() - MIN);
    await claimed(db, "t1", "ag_w1", "cl_1", past);
    await claimed(db, "t2", "ag_w2", "cl_2", past);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => {
      locked = r;
    });
    const holder = db.begin(async (tx) => {
      await tx`select 1 from tasks where thread_id = 't1' for update`;
      locked();
      await gate;
    });
    holder.catch(() => {});
    try {
      await Promise.race([lockedP, holder]);
      const first = await Promise.race([reapExpired(db), sleep(5000).then(() => "blocked" as const)]);
      assert.equal(first, 1, "reapExpired must not block on the locked row");
      const events = (await listEvents(db, {})).events;
      assert.deepEqual(events.map((e) => e.threadId), ["t2"]);
    } finally {
      release();
      await holder;
    }
    assert.equal(await reapExpired(db), 1);
    const events = (await listEvents(db, {})).events;
    assert.deepEqual(events.map((e) => e.threadId), ["t2", "t1"]);
  });
});

test("ready and blocked tasks are untouched", async () => {
  await withTestDb(async (db) => {
    await seed(db);
    await db`insert into tasks (thread_id, state, brief) values ('t1', 'ready', 'b'), ('t2', 'waiting', 'b')`;
    await db`insert into tasks (thread_id, state, brief, block) values ('t3', 'blocked', 'b', ${db.json({ kind: "approval", prompt: "ok?" })})`;
    const before = await db`select thread_id, state, updated_at from tasks order by thread_id`;
    assert.equal(await reapExpired(db, new Date(Date.now() + 60 * MIN)), 0);
    const after = await db`select thread_id, state, updated_at from tasks order by thread_id`;
    assert.deepEqual(after.map((r) => ({ ...r })), before.map((r) => ({ ...r })));
    assert.equal((await listEvents(db, {})).events.length, 0);
  });
});
