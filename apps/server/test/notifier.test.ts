import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { withTestDb } from "./helpers/db.js";
import { assertAguiValid } from "./helpers/agui.js";
import { createNotifier } from "../src/notifier.js";

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
}

test("two callbacks both receive the payload", async () => {
  await withTestDb(async (db) => {
    const n = await createNotifier(db);
    try {
      const a: string[] = [];
      const b: string[] = [];
      n.onEvent((c) => a.push(c));
      n.onEvent((c) => b.push(c));
      await db`select pg_notify('teamkit_events', '1')`;
      await until(() => a.length === 1 && b.length === 1);
      assert.deepEqual(a, ["1"]);
      assert.deepEqual(b, ["1"]);
    } finally {
      await n.close();
    }
  });
});

test("a throwing callback does not stop the others", async () => {
  await withTestDb(async (db) => {
    const n = await createNotifier(db);
    const origErr = console.error;
    console.error = () => {};
    try {
      const got: string[] = [];
      n.onEvent(() => {
        throw new Error("boom");
      });
      n.onEvent((c) => got.push(c));
      await db`select pg_notify('teamkit_events', '2')`;
      await until(() => got.length === 1);
      assert.deepEqual(got, ["2"]);
    } finally {
      console.error = origErr;
      await n.close();
    }
  });
});

test("unsubscribed callback no longer fires; the other still does", async () => {
  await withTestDb(async (db) => {
    const n = await createNotifier(db);
    try {
      const a: string[] = [];
      const b: string[] = [];
      const offA = n.onEvent((c) => a.push(c));
      n.onEvent((c) => b.push(c));
      await db`select pg_notify('teamkit_events', '1')`;
      await until(() => a.length === 1 && b.length === 1);
      offA();
      await db`select pg_notify('teamkit_events', '2')`;
      await until(() => b.length === 2);
      assert.deepEqual(a, ["1"]);
      assert.deepEqual(b, ["1", "2"]);
    } finally {
      await n.close();
    }
  });
});

test("notify inside a transaction is delivered only after commit; rollback delivers nothing", async () => {
  await withTestDb(async (db) => {
    const n = await createNotifier(db);
    try {
      const got: string[] = [];
      n.onEvent((c) => got.push(c));

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const tx = db.begin(async (sql) => {
        await sql`select pg_notify('teamkit_events', '10')`;
        await gate;
      });
      await sleep(300);
      assert.deepEqual(got, []);
      release();
      await tx;
      await until(() => got.length === 1);
      assert.deepEqual(got, ["10"]);

      await assert.rejects(
        db.begin(async (sql) => {
          await sql`select pg_notify('teamkit_events', '11')`;
          throw new Error("rollback");
        }),
        /rollback/,
      );
      await sleep(300);
      assert.deepEqual(got, ["10"]);
    } finally {
      await n.close();
    }
  });
});

test("close stops delivery and is safe to call twice", async () => {
  await withTestDb(async (db) => {
    const n = await createNotifier(db);
    const got: string[] = [];
    n.onEvent((c) => got.push(c));
    await n.close();
    await db`select pg_notify('teamkit_events', '1')`;
    await sleep(300);
    assert.deepEqual(got, []);
    await n.close();
  });
});

test("assertAguiValid accepts a valid CUSTOM event and names the bad index", () => {
  const valid = { type: "CUSTOM", name: "x", value: { a: 1 } };
  assertAguiValid([valid]);
  assert.throws(() => assertAguiValid([valid, { type: "NOPE" }]), /index 1/);
});
