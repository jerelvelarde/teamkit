import { test } from "node:test";
import { readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { createDb } from "../src/db/pool.js";
import { MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";
import { TEST_ADMIN_URL, createTestDatabase, withTestDb } from "./helpers/db.js";

const TABLES = ["actors", "tokens", "grants", "rooms", "threads", "tasks", "task_needs", "messages", "events", "schema_migrations", "sessions", "signin_links", "device_codes", "slack_links", "agents"];

async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
}

test("migrate applies every migration once and is idempotent", async () => {
  const t = await createTestDatabase({ migrate: false });
  try {
    assert.deepEqual(await migrate(t.db), await migrationFiles());
    assert.deepEqual(await migrate(t.db), []);
  } finally {
    await t.drop();
  }
});

test("all tables exist", async () => {
  await withTestDb(async (db) => {
    const rows = await db`select table_name from information_schema.tables where table_schema = 'public'`;
    const names = rows.map((r) => r.table_name as string).sort();
    assert.deepEqual(names, [...TABLES].sort());
  });
});

test("concurrent migrate applies each file once in total", async () => {
  const t = await createTestDatabase({ migrate: false });
  try {
    const [a, b] = await Promise.all([migrate(t.db), migrate(t.db)]);
    const files = await migrationFiles();
    assert.equal(a.length + b.length, files.length);
    assert.deepEqual([...a, ...b].sort(), files);
  } finally {
    await t.drop();
  }
});

test("withTestDb drops its database afterwards", async () => {
  let dbName = "";
  await withTestDb(async (db) => {
    const [r] = await db`select current_database() as n`;
    dbName = r!.n as string;
  });
  const admin = createDb(TEST_ADMIN_URL, { max: 1 });
  try {
    const rows = await admin`select 1 from pg_database where datname = ${dbName}`;
    assert.equal(rows.length, 0);
  } finally {
    await admin.end();
  }
});
