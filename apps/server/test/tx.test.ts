import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { MAX_ATTEMPTS, isRetryable, withRetry } from "../src/store/tx.js";

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

test("isRetryable matches deadlock and serialization failures only", () => {
  assert.equal(isRetryable(pgError("40P01")), true);
  assert.equal(isRetryable(pgError("40001")), true);
  assert.equal(isRetryable(pgError("23505")), false);
  assert.equal(isRetryable(new Error("x")), false);
  assert.equal(isRetryable(null), false);
});

test("a retryable failure reruns the transaction and earlier attempts roll back", async () => {
  await withTestDb(async (db) => {
    let calls = 0;
    const out = await withRetry(db, async (tx) => {
      calls++;
      await tx`insert into rooms (name) values (${`attempt-${calls}`})`;
      if (calls < MAX_ATTEMPTS) throw pgError("40P01");
      return "ok";
    });
    assert.equal(out, "ok");
    assert.equal(calls, MAX_ATTEMPTS);
    const rooms = await db`select name from rooms order by name`;
    assert.deepEqual(rooms.map((r) => r.name), [`attempt-${MAX_ATTEMPTS}`]);
  });
});

test("retries are bounded and other errors are not retried", async () => {
  await withTestDb(async (db) => {
    let calls = 0;
    await assert.rejects(
      withRetry(db, async () => {
        calls++;
        throw pgError("40001");
      }),
      (e: unknown) => (e as { code?: string }).code === "40001",
    );
    assert.equal(calls, MAX_ATTEMPTS);
    calls = 0;
    await assert.rejects(
      withRetry(db, async () => {
        calls++;
        throw pgError("23505");
      }),
      (e: unknown) => (e as { code?: string }).code === "23505",
    );
    assert.equal(calls, 1);
  });
});

test("two transactions locking rows in opposite orders both commit", async () => {
  await withTestDb(async (db) => {
    await db`insert into rooms (name) values ('a'), ('b')`;
    let firstLocks = 0;
    let bothHold!: () => void;
    const held = new Promise<void>((resolve) => (bothHold = resolve));
    const lockPair = (first: string, second: string) =>
      withRetry(db, async (tx) => {
        await tx`select name from rooms where name = ${first} for update`;
        if (++firstLocks === 2) bothHold();
        await held;
        await tx`select name from rooms where name = ${second} for update`;
        await tx`update rooms set agent = ${first} where name = ${second}`;
        return first;
      });
    assert.deepEqual(await Promise.all([lockPair("a", "b"), lockPair("b", "a")]), ["a", "b"]);
    assert.ok(firstLocks >= 3, "the deadlock victim was rerun");
    const rows = await db`select name, agent from rooms order by name`;
    assert.deepEqual(rows.map((r) => [r.name, r.agent]), [["a", "b"], ["b", "a"]]);
  });
});
