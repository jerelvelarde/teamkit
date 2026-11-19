import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type AddressInfo, type Socket } from "node:net";
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
    host: "127.0.0.1",
    reapIntervalMs: 15000,
    publicUrl: "http://127.0.0.1:3000",
    dispatch: true,
    triggers: true,
    dispatchConcurrency: 4,
    trustedProxy: false,
    mail: null,
    slack: {
      bridge: {
        intelligenceApiKey: undefined,
        intelligenceApiUrl: undefined,
        intelligenceWsUrl: undefined,
        channelName: undefined,
        publicUrl: "http://127.0.0.1:3000",
        defaultRoom: null,
      },
      botToken: undefined,
      apiBase: "https://slack.com/api",
    },
  });
  assert.equal(loadConfig({ TEAMKIT_PUBLIC_URL: "https://b.example.com/" }).publicUrl, "https://b.example.com");
  assert.equal(loadConfig({ PORT: "0" }).port, 0);
  assert.equal(loadConfig({ TEAMKIT_TRUSTED_PROXY: "1" }).trustedProxy, true);
  assert.equal(loadConfig({ TEAMKIT_TRUSTED_PROXY: "0" }).trustedProxy, false);
  assert.equal(loadConfig({ TEAMKIT_DISPATCH: "off" }).dispatch, false);
  assert.equal(loadConfig({ TEAMKIT_DISPATCH: "on" }).dispatch, true);
  assert.equal(loadConfig({ TEAMKIT_DISPATCH_CONCURRENCY: "2" }).dispatchConcurrency, 2);
  assert.throws(() => loadConfig({ TEAMKIT_DISPATCH_CONCURRENCY: "0" }), /TEAMKIT_DISPATCH_CONCURRENCY/);
  assert.throws(() => loadConfig({ TEAMKIT_DISPATCH_CONCURRENCY: "x" }), /TEAMKIT_DISPATCH_CONCURRENCY/);
  assert.equal(loadConfig({ TEAMKIT_TRIGGERS: "off" }).triggers, false);
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
  err: string;
  exitCode: () => Promise<number | null>;
  stop: () => Promise<void>;
}

async function startMain(databaseUrl: string, extraEnv: Record<string, string> = {}): Promise<Started> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd,
    env: { ...process.env, DATABASE_URL: databaseUrl, PORT: "0", HOST: "127.0.0.1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const state = { out: "" };
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line in 10s: ${state.out}${err}`)), 10_000);
    child.stdout.on("data", (d) => {
      state.out += d;
      // Slack startup logs follow the listening line, so wait for both.
      if (/teamkit-server listening on /.test(state.out) && /slack bridge off/.test(state.out)) {
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
    get err() {
      return err;
    },
    exitCode: async () => {
      child.kill("SIGTERM");
      const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000))]);
      return code === "timeout" ? null : code;
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

test("main.ts logs that the Slack bridge is off, and no outbound line, without Slack env", async () => {
  const t = await createTestDatabase({ migrate: false });
  const s = await startMain(t.url);
  try {
    assert.match(s.out, /slack bridge off \(set CPK_INTELLIGENCE_API_KEY and TEAMKIT_SLACK_CHANNEL_NAME\)/);
    assert.doesNotMatch(s.out, /slack outbound started/);
  } finally {
    await s.stop();
    await t.drop();
  }
});

test("main.ts runs the dispatcher by default and exits 0 on SIGTERM", async () => {
  const t = await createTestDatabase({ migrate: false });
  const s = await startMain(t.url);
  try {
    assert.match(s.out, /dispatcher started \(concurrency 4\)/);
    assert.equal(await s.exitCode(), 0);
  } finally {
    await s.stop();
    await t.drop();
  }
});

test("main.ts honours TEAMKIT_DISPATCH=off and TEAMKIT_DISPATCH_CONCURRENCY", async () => {
  const t = await createTestDatabase({ migrate: false });
  const off = await startMain(t.url, { TEAMKIT_DISPATCH: "off" });
  try {
    assert.doesNotMatch(off.out, /dispatcher started/);
    assert.equal(await off.exitCode(), 0);
  } finally {
    await off.stop();
  }
  const two = await startMain(t.url, { TEAMKIT_DISPATCH_CONCURRENCY: "2" });
  try {
    assert.match(two.out, /dispatcher started \(concurrency 2\)/);
  } finally {
    await two.stop();
    await t.drop();
  }
});

test("main.ts runs triggers by default, and TEAMKIT_TRIGGERS=off turns them off", async () => {
  const t = await createTestDatabase({ migrate: false });
  const on = await startMain(t.url);
  try {
    assert.match(on.out, /dispatcher started[^]*triggers started/);
    assert.equal(await on.exitCode(), 0);
  } finally {
    await on.stop();
  }
  const off = await startMain(t.url, { TEAMKIT_TRIGGERS: "off" });
  try {
    assert.doesNotMatch(off.out, /triggers started/);
    assert.equal(await off.exitCode(), 0);
  } finally {
    await off.stop();
    await t.drop();
  }
});

test("main.ts boots with every loop on, stops them before the db, and leaves no process behind", async () => {
  const t = await createTestDatabase({ migrate: false });
  const s = await startMain(t.url, { SLACK_BOT_TOKEN: "xoxb-test", SLACK_API_BASE: "http://127.0.0.1:9" });
  try {
    assert.match(s.out, /dispatcher started/);
    assert.match(s.out, /triggers started/);
    assert.match(s.out, /slack outbound started/);
    assert.equal(await s.exitCode(), 0);
    // Both locks and their connections went with the process. Only this database's locks:
    // test files running alongside hold their own.
    const locks = () => t.db`
      select 1 from pg_locks l join pg_database d on d.oid = l.database
      where l.locktype = 'advisory' and d.datname = current_database()`;
    let rows = await locks();
    for (let i = 0; i < 50 && rows.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = await locks();
    }
    assert.equal(rows.length, 0);
  } finally {
    await s.stop();
    await t.drop();
  }
});

test("main.ts starts Slack outbound with SLACK_BOT_TOKEN, exits 0, and never prints the token", async () => {
  const t = await createTestDatabase({ migrate: false });
  const s = await startMain(t.url, { SLACK_BOT_TOKEN: "xoxb-test", SLACK_API_BASE: "http://127.0.0.1:9" });
  try {
    assert.match(s.out, /slack outbound started/);
    assert.match(s.out, /slack bridge off/);
    const code = await s.exitCode();
    assert.equal(code, 0);
    assert.ok(!s.out.includes("xoxb-test"), "token in stdout");
    assert.ok(!s.err.includes("xoxb-test"), "token in stderr");
  } finally {
    await s.stop();
    await t.drop();
  }
});

test("main.ts exits 0 on a SIGTERM while the Slack bridge is still waiting for its Channel", async () => {
  const t = await createTestDatabase({ migrate: false });
  // A fake key and a local server that accepts connections and never answers: the bridge waits
  // (up to 30 s) for its Channel.
  const sockets = new Set<Socket>();
  const silent = createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  const silentPort = (silent.address() as AddressInfo).port;
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd,
    env: {
      ...process.env,
      DATABASE_URL: t.url,
      PORT: "0",
      HOST: "127.0.0.1",
      CPK_INTELLIGENCE_API_KEY: "cpk-1_test-not-a-real-key",
      CPK_INTELLIGENCE_API_URL: `http://127.0.0.1:${silentPort}`,
      CPK_INTELLIGENCE_WS_URL: `ws://127.0.0.1:${silentPort}`,
      COPILOTKIT_TELEMETRY_DISABLED: "true",
      TEAMKIT_SLACK_CHANNEL_NAME: "teamkit",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listening line in 10s: ${out}${err}`)), 10_000);
      child.stdout.on("data", (d) => {
        out += d;
        if (/teamkit-server listening on /.test(out)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    // Let the bridge get into its wait for the Channel.
    await new Promise((r) => setTimeout(r, 1_500));
    assert.doesNotMatch(out, /slack bridge (status|off)/, `the bridge was still starting: ${err}`);
    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no exit within 5s: ${out}${err}`)), 5_000)),
    ]);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.ok(!(out + err).includes("cpk-1_test-not-a-real-key"), "key in the logs");
    assert.doesNotMatch(err, /SLACK BRIDGE FAILED/);
  } finally {
    child.kill("SIGKILL");
    for (const sock of sockets) sock.destroy();
    await new Promise((r) => silent.close(r));
    await t.drop();
  }
});
