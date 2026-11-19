import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { main } from "../src/index.js";

const bin = fileURLToPath(new URL("../bin/teamkit.mjs", import.meta.url));

function run(...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TEAMKIT_")));
  return spawnSync(process.execPath, [bin, ...args], { env, encoding: "utf8" });
}

test("--help exits 0 and lists tasks", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: teamkit/);
  assert.match(r.stdout, /tasks/);
});

test("--version exits 0", () => {
  assert.equal(run("--version").status, 0);
});

test("an unknown command exits 2", () => {
  assert.equal(run("bogus").status, 2);
});

test("main resolves 0 for --help in process", async () => {
  assert.equal(await main(["node", "teamkit", "--help"], { out() {}, err() {} }), 0);
});
