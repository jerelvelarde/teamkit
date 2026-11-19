import { randomBytes } from "node:crypto";
import { createDb, type Db } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";

export const TEST_ADMIN_URL =
  process.env.TEAMKIT_TEST_DATABASE_URL ?? "postgres://teamkit@127.0.0.1:54329/postgres";

export async function createTestDatabase(
  opts?: { migrate?: boolean },
): Promise<{ db: Db; url: string; drop(): Promise<void> }> {
  const name = `teamkit_test_${randomBytes(6).toString("hex")}`;
  const admin = createDb(TEST_ADMIN_URL, { max: 1 });
  let db: Db | undefined;
  try {
    await admin.unsafe(`create database "${name}"`);
    const u = new URL(TEST_ADMIN_URL);
    u.pathname = `/${name}`;
    const url = u.toString();
    db = createDb(url);
    if (opts?.migrate !== false) await migrate(db);
    const d = db;
    let dropped = false;
    return {
      db: d,
      url,
      async drop() {
        if (dropped) return;
        dropped = true;
        try {
          await d.end({ timeout: 5 });
          await admin.unsafe(`drop database if exists "${name}" with (force)`);
        } finally {
          // An open admin connection would keep the test file from exiting.
          await admin.end({ timeout: 5 });
        }
      },
    };
  } catch (err) {
    await db?.end({ timeout: 5 }).catch(() => {});
    await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {});
    await admin.end().catch(() => {});
    throw err;
  }
}

export async function withTestDb(fn: (db: Db, url: string) => Promise<void>): Promise<void> {
  const t = await createTestDatabase();
  try {
    await fn(t.db, t.url);
  } catch (err) {
    // fn's error is the one worth reporting; a drop failure here would mask it.
    await t.drop().catch(() => {});
    throw err;
  }
  await t.drop();
}
