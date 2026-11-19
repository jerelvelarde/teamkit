import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createTestDatabase } from "./helpers/db.js";

const cwd = fileURLToPath(new URL("..", import.meta.url));

test("loadConfig defaults and validation", () => {
  assert.deepEqual(loadConfig({}), {
    databaseUrl: "postgres://teamkit@127.0.0.1:54329/teamkit",
    port: 8787,
    host: "0.0.0.0",
    reapIntervalMs: 15000,
  });
  assert.equal(loadConfig({ PORT: "0" }).port, 0);
  assert.throws(() => loadConfig({ PORT: "abc" }), /PORT/);
  assert.throws(() => loadConfig({ TEAMKIT_REAP_INTERVAL_MS: "x" }), /TEAMKIT_REAP_INTERVAL_MS/);
});

test("main.ts migrates, serves, and exits 0 on SIGTERM", async () => {
  const t = await createTestDatabase({ migrate: false });
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd,
    env: { ...process.env, DATABASE_URL: t.url, PORT: "0", HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listening line in 10s: ${out}${err}`)), 10_000);
      child.stdout.on("data", (d) => {
        out += d;
        const m = out.match(/teamkit-server listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`exited early: ${out}${err}`));
      });
    });
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const rows = await t.db`select name from schema_migrations`;
    assert.ok(rows.some((r) => r.name === "001_init.sql"));
    child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no exit within 5s")), 5_000)),
    ]);
    assert.equal(code, 0);
  } finally {
    child.kill("SIGKILL");
    await t.drop();
  }
});
