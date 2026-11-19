import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { custom, type BoardEvent } from "@copilotkit/teamkit-protocol";
import type { Db } from "../src/db/pool.js";
import { appendEvent, currentCursor, listEvents, type AppendEventInput } from "../src/store/events.js";
import { withTestDb } from "./helpers/db.js";

async function seedActors(db: Db): Promise<void> {
  await db`insert into actors (id, kind, name, role) values ('pe_ada', 'person', 'ada', 'admin')`;
  await db`insert into actors (id, kind, name, owner_id) values ('ag_w1', 'agent', 'worker-1', 'pe_ada')`;
}

function input(over: Partial<AppendEventInput> & { tag: string }): AppendEventInput {
  const { tag, ...rest } = over;
  return {
    kind: "message.posted",
    room: "build",
    threadId: null,
    actorId: null,
    agui: [custom("teamkit.test", { tag })],
    data: { tag },
    ...rest,
  };
}

function append(db: Db, over: Partial<AppendEventInput> & { tag: string }): Promise<BoardEvent> {
  return db.begin((tx) => appendEvent(tx, input(over)));
}

/** Appends inside a transaction that stays open until `release()` is called. */
async function openAppend(
  db: Db,
  over: Partial<AppendEventInput> & { tag: string },
): Promise<{ event: BoardEvent; release: () => void; done: Promise<BoardEvent> }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let appended!: (e: BoardEvent) => void;
  const appendedP = new Promise<BoardEvent>((r) => {
    appended = r;
  });
  const done = db.begin(async (tx) => {
    const ev = await appendEvent(tx, input(over));
    appended(ev);
    await gate;
    return ev;
  });
  done.catch(() => {});
  const event = await Promise.race([appendedP, done]);
  return { event, release, done };
}

const tags = (events: BoardEvent[]) => events.map((e) => e.data.tag);

test("appendEvent returns strictly increasing cursors and resolves the actor", async () => {
  await withTestDb(async (db) => {
    await seedActors(db);
    const a = await append(db, { tag: "a", actorId: "ag_w1", threadId: "th_1", kind: "thread.created" });
    const b = await append(db, { tag: "b", actorId: "pe_ada" });
    const c = await db.begin((tx) =>
      appendEvent(tx, { kind: "task.ready", room: "build/x", threadId: null, actorId: null, agui: [] }),
    );

    for (const e of [a, b, c]) assert.match(e.cursor, /^\d+$/);
    assert.ok(BigInt(a.cursor) < BigInt(b.cursor));
    assert.ok(BigInt(b.cursor) < BigInt(c.cursor));

    assert.deepEqual(a.actor, { id: "ag_w1", name: "worker-1", kind: "agent" });
    assert.deepEqual(b.actor, { id: "pe_ada", name: "ada", kind: "person" });
    assert.equal(c.actor, null);

    assert.equal(a.kind, "thread.created");
    assert.equal(a.room, "build");
    assert.equal(a.threadId, "th_1");
    assert.deepEqual(a.agui, [custom("teamkit.test", { tag: "a" })]);
    assert.deepEqual(a.data, { tag: "a" });
    assert.equal(new Date(a.createdAt).toISOString(), a.createdAt);
    assert.deepEqual(c.data, {});
    assert.deepEqual(c.agui, []);

    // listEvents returns the same shape appendEvent did.
    const listed = await listEvents(db, {});
    assert.deepEqual(listed.events, [a, b, c]);
    assert.equal(await currentCursor(db), c.cursor);
  });
});

test("listEvents filters by after, room, thread, kinds and limit", async () => {
  await withTestDb(async (db) => {
    await seedActors(db);
    const e1 = await append(db, { tag: "1", room: "build", threadId: "th_1", kind: "thread.created", actorId: "ag_w1" });
    await append(db, { tag: "2", room: "build/x", threadId: "th_2", kind: "message.posted" });
    await append(db, { tag: "3", room: "builder", threadId: "th_3", kind: "message.posted" });
    const e4 = await append(db, { tag: "4", room: "build", threadId: "th_1", kind: "label.set" });
    const e5 = await append(db, { tag: "5", room: "other", threadId: null, kind: "task.created" });

    const all = await listEvents(db, {});
    assert.deepEqual(tags(all.events), ["1", "2", "3", "4", "5"]);
    assert.equal(all.cursor, e5.cursor);

    const afterTwo = await listEvents(db, { after: all.events[1]!.cursor });
    assert.deepEqual(tags(afterTwo.events), ["3", "4", "5"]);

    assert.deepEqual(tags((await listEvents(db, { room: "build/" })).events), ["1", "2", "4"]);
    assert.deepEqual(tags((await listEvents(db, { room: "build" })).events), ["1", "4"]);
    assert.deepEqual(tags((await listEvents(db, { room: "build/x" })).events), ["2"]);
    assert.deepEqual(tags((await listEvents(db, { room: "*" })).events), ["1", "2", "3", "4", "5"]);
    assert.deepEqual(tags((await listEvents(db, { threadId: "th_1" })).events), ["1", "4"]);
    assert.deepEqual(
      tags((await listEvents(db, { kinds: ["message.posted", "task.created"] })).events),
      ["2", "3", "5"],
    );
    assert.deepEqual(tags((await listEvents(db, { kinds: [] })).events), ["1", "2", "3", "4", "5"]);
    assert.deepEqual(
      tags((await listEvents(db, { room: "build/", kinds: ["message.posted"], after: e1.cursor })).events),
      ["2"],
    );

    const byRoom = await listEvents(db, { room: "build/", after: e1.cursor });
    assert.deepEqual(tags(byRoom.events), ["2", "4"]);
    assert.equal(byRoom.cursor, e4.cursor);

    const two = await listEvents(db, { limit: 2 });
    assert.deepEqual(tags(two.events), ["1", "2"]);
    assert.equal(two.cursor, all.events[1]!.cursor);
    assert.deepEqual(tags((await listEvents(db, { limit: 0 })).events), ["1"]);
    assert.deepEqual(tags((await listEvents(db, { limit: -5 })).events), ["1"]);

    await db`
      insert into events (kind, room, agui, data)
      select 'message.posted', 'bulk', '[]'::jsonb, jsonb_build_object('n', n) from generate_series(1, 1001) n`;
    const bulkDefault = await listEvents(db, { room: "bulk" });
    assert.equal(bulkDefault.events.length, 200);
    const bulkMax = await listEvents(db, { room: "bulk", limit: 5000 });
    assert.equal(bulkMax.events.length, 1000);
    const ns = bulkMax.events.map((e) => e.data.n as number);
    assert.deepEqual(ns, Array.from({ length: 1000 }, (_, i) => i + 1));
    for (let i = 1; i < bulkMax.events.length; i++) {
      assert.ok(BigInt(bulkMax.events[i - 1]!.cursor) < BigInt(bulkMax.events[i]!.cursor));
    }
  });
});

test("listEvents cursor fallback: last event, else after, else currentCursor", async () => {
  await withTestDb(async (db) => {
    assert.equal(await currentCursor(db), "0");
    assert.deepEqual(await listEvents(db, {}), { events: [], cursor: "0" });
    assert.deepEqual(await listEvents(db, { room: "build" }), { events: [], cursor: "0" });

    const e1 = await append(db, { tag: "1" });
    const e2 = await append(db, { tag: "2" });
    const e3 = await append(db, { tag: "3", room: "other" });
    assert.equal(await currentCursor(db), e3.cursor);

    // Last event's cursor.
    assert.equal((await listEvents(db, { after: e1.cursor })).cursor, e3.cursor);
    assert.equal((await listEvents(db, { room: "build" })).cursor, e2.cursor);
    // Nothing matched: `after`.
    assert.deepEqual(await listEvents(db, { room: "nomatch", after: e1.cursor }), { events: [], cursor: e1.cursor });
    assert.deepEqual(await listEvents(db, { after: e3.cursor }), { events: [], cursor: e3.cursor });
    // Nothing matched and no `after`: the current head.
    assert.deepEqual(await listEvents(db, { room: "nomatch" }), { events: [], cursor: e3.cursor });
    assert.deepEqual(await listEvents(db, { threadId: "th_none" }), { events: [], cursor: e3.cursor });
  });
});

test("an event in an open transaction is invisible to other connections until commit", async () => {
  await withTestDb(async (db) => {
    const c0 = await currentCursor(db);
    const open = await openAppend(db, { tag: "open" });
    try {
      assert.deepEqual(await listEvents(db, { after: c0 }), { events: [], cursor: c0 });
      assert.deepEqual(await listEvents(db, {}), { events: [], cursor: c0 });
      assert.equal(await currentCursor(db), c0);
    } finally {
      open.release();
    }
    const committed = await open.done;
    const after = await listEvents(db, { after: c0 });
    assert.deepEqual(after.events, [committed]);
    assert.equal(after.cursor, open.event.cursor);
  });
});

test("concurrent appends commit in cursor order, so a reader following the cursor never skips one", async () => {
  await withTestDb(async (db) => {
    await append(db, { tag: "seed" });
    const c0 = await currentCursor(db);

    const a = await openAppend(db, { tag: "A" });
    let bSettled = false;
    const bDone = append(db, { tag: "B" }).finally(() => {
      bSettled = true;
    });
    bDone.catch(() => {});
    try {
      // While A is open, B waits on the log lock and a reader sees nothing new.
      const until = Date.now() + 200;
      while (Date.now() < until) {
        assert.deepEqual(await listEvents(db, { after: c0 }), { events: [], cursor: c0 });
        await sleep(25);
      }
      assert.equal(bSettled, false, "B's append must still be pending while A is open");
      const [waiting] = await db<{ n: number }[]>`
        select count(*)::int as n from pg_locks
        where locktype = 'advisory' and objid = 7731 and not granted
          and database = (select oid from pg_database where datname = current_database())`;
      assert.equal(waiting!.n, 1, "B must be waiting on the event-log advisory lock");
      // B must wait BEFORE it allocates a cursor; otherwise a late commit of A could be skipped.
      const [seq] = await db<{ last: string }[]>`select last_value::text as last from events_cursor_seq`;
      assert.equal(seq!.last, a.event.cursor, "B allocated a cursor before taking the event-log lock");

      // Follow the log by cursor while A commits and B goes through.
      const seen: BoardEvent[] = [];
      const reader = (async () => {
        let cursor = c0;
        const deadline = Date.now() + 5000;
        while (seen.length < 2) {
          if (Date.now() > deadline) throw new Error(`reader timed out; saw ${JSON.stringify(tags(seen))}`);
          const r = await listEvents(db, { after: cursor });
          seen.push(...r.events);
          const t = tags(seen);
          if (t.includes("B")) assert.deepEqual(t.slice(0, 2), ["A", "B"], "reader saw B without A first");
          cursor = r.cursor;
        }
        return null;
      })().catch((err: unknown) => err);

      a.release();
      const [aEvent, bEvent] = await Promise.all([a.done, bDone]);
      const readerErr = await reader;
      if (readerErr) throw readerErr;

      assert.ok(BigInt(bEvent.cursor) > BigInt(aEvent.cursor));
      assert.deepEqual(tags(seen), ["A", "B"]);
      assert.deepEqual(
        seen.map((e) => e.cursor),
        [aEvent.cursor, bEvent.cursor],
      );
    } finally {
      a.release();
      await Promise.allSettled([a.done, bDone]);
    }
  });
});
