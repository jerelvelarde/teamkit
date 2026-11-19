import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./pool.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7730)`;
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  });
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const name of files) {
    const [row] = await db`select 1 as one from schema_migrations where name = ${name}`;
    if (row) continue;
    const text = await readFile(join(dir, name), "utf8");
    await db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(7730)`;
      const [again] = await tx`select 1 as one from schema_migrations where name = ${name}`;
      if (again) return;
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${name})`;
      applied.push(name);
    });
  }
  return applied;
}
