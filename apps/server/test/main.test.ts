import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { consumeSignInLink } from "../src/store/people.js";
import { createTestDatabase } from "./helpers/db.js";

const cwd = fileURLToPath(new URL("..", import.meta.url));

test("loadConfig defaults and validation", () => {
  assert.deepEqual(loadConfig({}), {
    databaseUrl: "postgres://teamkit@127.0.0.1:54329/teamkit",
    port: 8787,
    host: "0.0.0.0",
    reapIntervalMs: 15000,
    publicUrl: "http://127.0.0.1:3000",
  });
  assert.equal(loadConfig({ TEAMKIT_PUBLIC_URL: "https://b.example.com/" }).publicUrl, "https://b.example.com");
  assert.equal(loadConfig({ PORT: "0" }).port, 0);
  assert.throws(() => loadConfig({ PORT: "abc" }), /PORT/);
  assert.throws(() => loadConfig({ TEAMKIT_PUBLIC_URL: "ftp://x" }), /TEAMKIT_PUBLIC_URL/);
  assert.throws(() => loadConfig({ TEAMKIT_PUBLIC_URL: "nope" }), /TEAMKIT_PUBLIC_URL/);
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

interface Started {
  out: string;
  stop: () => Promise<void>;
}

async function startMain(databaseUrl: string, extraEnv: Record<string, string> = {}): Promise<Started> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd,
    env: { ...process.env, DATABASE_URL: databaseUrl, PORT: "0", HOST: "127.0.0.1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const state = { out: "" };
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line in 10s: ${state.out}${err}`)), 10_000);
    child.stdout.on("data", (d) => {
      state.out += d;
      if (/teamkit-server listening on /.test(state.out)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`exited early: ${state.out}${err}`));
    });
  });
  return {
    get out() {
      return state.out;
    },
    stop: async () => {
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      child.kill("SIGKILL");
    },
  };
}

const LINK_LINE = /bootstrap admin sign-in link \(valid 24 h\): (\S+)/;

test("main.ts prints the bootstrap admin sign-in link once, before the listening line", async () => {
  const t = await createTestDatabase({ migrate: false });
  try {
    const first = await startMain(t.url);
    let link: string;
    try {
      const prefix = "bootstrap admin sign-in link (valid 24 h): http://127.0.0.1:3000/signin/sl_";
      assert.ok(first.out.includes(prefix), first.out);
      assert.ok(first.out.indexOf(prefix) < first.out.indexOf("teamkit-server listening"));
      link = first.out.match(LINK_LINE)![1]!;
    } finally {
      await first.stop();
    }
    const secret = link.slice(link.lastIndexOf("/") + 1);
    await consumeSignInLink(t.db, secret);
    const second = await startMain(t.url);
    try {
      assert.doesNotMatch(second.out, /bootstrap admin sign-in link/);
    } finally {
      await second.stop();
    }
  } finally {
    await t.drop();
  }
});

test("main.ts builds the bootstrap link from TEAMKIT_PUBLIC_URL", async () => {
  const t = await createTestDatabase({ migrate: false });
  const s = await startMain(t.url, { TEAMKIT_PUBLIC_URL: "https://board.example.com" });
  try {
    assert.ok(s.out.includes("https://board.example.com/signin/sl_"), s.out);
  } finally {
    await s.stop();
    await t.drop();
  }
});
