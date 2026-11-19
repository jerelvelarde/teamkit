import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { isolatedEnv, runCli, runNode, spawnCli } from "./helpers/cli.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("isolatedEnv strips TEAMKIT_* and keeps PATH", () => {
  process.env.TEAMKIT_URL = "http://x";
  process.env.TEAMKIT_TOKEN = "t";
  try {
    const env = isolatedEnv();
    assert.equal(env.TEAMKIT_URL, undefined);
    assert.equal(env.TEAMKIT_TOKEN, undefined);
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    delete process.env.TEAMKIT_URL;
    delete process.env.TEAMKIT_TOKEN;
  }
});

test("isolatedEnv gives fresh existing temp dirs and extra wins", () => {
  const a = isolatedEnv();
  const b = isolatedEnv({ XDG_STATE_HOME: "/override", FOO: "bar" });
  for (const d of [a.XDG_CONFIG_HOME!, a.XDG_STATE_HOME!]) {
    assert.ok(existsSync(d) && statSync(d).isDirectory());
  }
  assert.notEqual(a.XDG_CONFIG_HOME, b.XDG_CONFIG_HOME);
  assert.equal(b.XDG_STATE_HOME, "/override");
  assert.equal(b.FOO, "bar");
});

test("runCli --version prints the package version", async () => {
  const r = await runCli(["--version"], isolatedEnv());
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), version);
});

test("runNode kills a child that outlives timeoutMs", async () => {
  const start = Date.now();
  const r = await runNode(["-e", "setInterval(()=>{},1000)"], isolatedEnv(), { timeoutMs: 300 });
  assert.equal(r.signal, "SIGKILL");
  assert.ok(Date.now() - start < 2000);
});

test("runNode feeds input to stdin", async () => {
  const r = await runNode(["-e", "process.stdin.pipe(process.stdout)"], isolatedEnv(), { input: "hello" });
  assert.equal(r.stdout, "hello");
});

test("spawnCli returns a child that exits 0 for --help", async () => {
  const child = spawnCli(["--help"], isolatedEnv());
  child.stdout!.resume();
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
});
