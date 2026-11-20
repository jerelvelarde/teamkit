import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { loadTask, loadTasks } from "../src/store/task-load.js";
import type { Db } from "../src/db/pool.js";

async function seed(db: Db) {
  await db`insert into actors (id, kind, name, role) values ('p1','person','alice','admin'), ('a1','agent','bot',null)`;
  await db`insert into rooms (name) values ('build')`;
  for (const id of ["t1", "t2", "t3", "t4"]) {
    await db`insert into threads (id, room, is_task, labels, created_by) values (${id}, 'build', true, ${db.json({ k: id })}, 'p1')`;
  }
  await db`insert into tasks (thread_id, state, brief) values ('t2','completed','b2'), ('t3','ready','b3')`;
}

test("claimed row hydrates claim with ISO lease", async () => {
  await withTestDb(async (db) => {
    await seed(db);
    await db`insert into tasks (thread_id, state, brief, target, claim_id, claimed_by, lease_expires_at, attempts)
             values ('t1','claimed','do it','a1','c1','a1','2030-01-01T00:00:00Z', 2)`;
    const t = await loadTask(db, "t1");
    assert.ok(t);
    assert.deepEqual(t.claim, {
      id: "c1",
      actor: { id: "a1", name: "bot", kind: "agent" },
      leaseExpiresAt: "2030-01-01T00:00:00.000Z",
    });
    assert.equal(t.id, "t1");
    assert.equal(t.room, "build");
    assert.deepEqual(t.labels, { k: "t1" });
    assert.deepEqual(t.createdBy, { id: "p1", name: "alice", kind: "person" });
    assert.equal(t.target, "a1");
    assert.equal(t.attempts, 2);
    assert.equal(t.block, null);
    assert.equal(t.pendingResume, null);
    assert.match(t.createdAt, /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.match(t.updatedAt, /Z$/);
  });
});

test("waiting row returns sorted needs and needStates", async () => {
  await withTestDb(async (db) => {
    await seed(db);
    await db`insert into tasks (thread_id, state, brief) values ('t1','waiting','w')`;
    await db`insert into task_needs (task_id, needs_id) values ('t1','t3'), ('t1','t2')`;
    const t = await loadTask(db, "t1");
    assert.deepEqual(t!.needs, ["t2", "t3"]);
    assert.deepEqual(t!.needStates, { t2: "completed", t3: "ready" });
    assert.equal(t!.claim, null);
  });
});

test("blocked row returns block, pendingResume and attempts as stored", async () => {
  await withTestDb(async (db) => {
    await seed(db);
    const block = {
      interruptId: "i1",
      kind: "needs_input",
      question: "which?",
      options: ["x", "y"],
      blockedBy: { id: "a1", name: "bot", kind: "agent" },
    };
    const resume = [{ interruptId: "i0", status: "resolved", payload: { choice: "x" } }];
    await db`insert into tasks (thread_id, state, brief, block, pending_resume, attempts)
             values ('t1','blocked','b', ${db.json(block)}, ${db.json(resume)}, 3)`;
    const t = await loadTask(db, "t1");
    assert.deepEqual(t!.block, { ...block, approvers: null });
    assert.deepEqual(t!.pendingResume, resume);
    assert.equal(t!.attempts, 3);
  });
});

test("unknown id returns null", async () => {
  await withTestDb(async (db) => {
    await seed(db);
    assert.equal(await loadTask(db, "nope"), null);
    assert.equal(await db.begin((tx) => loadTask(tx, "nope", { forUpdate: true })), null);
  });
});

test("loadTasks keeps input order and skips unknown ids", async () => {
  await withTestDb(async (db) => {
    await seed(db);
    assert.deepEqual(await loadTasks(db, []), []);
    const ts = await loadTasks(db, ["t3", "missing", "t2"]);
    assert.deepEqual(ts.map((t) => t.id), ["t3", "t2"]);
  });
});

test("forUpdate holds a row lock until the transaction ends", async () => {
  await withTestDb(async (db) => {
    await seed(db);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const holder = db.begin(async (tx) => {
      const t = await loadTask(tx, "t3", { forUpdate: true });
      assert.equal(t!.id, "t3");
      locked();
      await gate;
    });
    await lockedP;
    let updated = false;
    const updater = db`update tasks set brief = 'changed' where thread_id = 't3'`.then(() => {
      updated = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(updated, false);
    release();
    await holder;
    await updater;
    assert.equal(updated, true);
  });
});

async function seedBilling(db: Db) {
  await db`insert into actors (id, kind, name, role) values ('ac_ben', 'person', 'ben', 'member')`;
  await db`insert into actors (id, kind, name, owner_id) values ('ac_ben_agent', 'agent', 'ben-agent', 'ac_ben')`;
  await db`insert into rooms (name) values ('billing-migration')`;
  await db`insert into threads (id, room, is_task, created_by) values ('th_backfill', 'billing-migration', true, 'ac_ben')`;
  await db`insert into tasks (thread_id, state, brief) values ('th_backfill', 'ready', 'Backfill invoices_v2 from invoices_v1')`;
}

test("a task with no hold reads reservedFor and reservedUntil null", async () => {
  await withTestDb(async (db) => {
    await seedBilling(db);
    const t = await loadTask(db, "th_backfill");
    assert.equal(t!.reservedFor, null);
    assert.equal(t!.reservedUntil, null);
  });
});

test("a stored hold reads back as the holder and an ISO time", async () => {
  await withTestDb(async (db) => {
    await seedBilling(db);
    await db`update tasks set reserved_for = 'ac_ben_agent', reserved_until = '2026-11-19T10:30:00Z', reservation_kind = 'handoff'
             where thread_id = 'th_backfill'`;
    const t = await loadTask(db, "th_backfill");
    assert.deepEqual(t!.reservedFor, { id: "ac_ben_agent", name: "ben-agent", kind: "agent" });
    assert.equal(t!.reservedUntil, "2026-11-19T10:30:00.000Z");
  });
});

test("a hold must be whole: holder, time and kind together", async () => {
  await withTestDb(async (db) => {
    await seedBilling(db);
    await assert.rejects(db`update tasks set reserved_for = 'ac_ben_agent' where thread_id = 'th_backfill'`,
      (e) => (e as { code?: string }).code === "23514");
  });
});
