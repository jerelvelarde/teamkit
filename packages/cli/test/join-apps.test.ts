import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { after, before, test } from "node:test";
import { approveDevice } from "../../../apps/server/src/store/device.js";
import { personAuth } from "../../../apps/server/test/helpers/actors.js";
import { startTestServer } from "../../../apps/server/test/helpers/server.js";
import { configPath, readConfigFile, writeConfigFile } from "../src/config.js";
import { BIN, isolatedEnv, linkedBin, runCli, spawnCli } from "./helpers/cli.js";

// Its own server, apart from join.test.ts: device/start allows each client address a burst of 10.
let server: Awaited<ReturnType<typeof startTestServer>>;
let ana: Awaited<ReturnType<typeof personAuth>>;

before(async () => {
  server = await startTestServer();
  ana = await personAuth(server.db, "ana", "member");
});

after(async () => {
  await server.stop();
});

/** Starts `teamkit <args>` from `bin`, returns its login code and the exit result. */
async function startJoin(args: string[], env: NodeJS.ProcessEnv, bin = BIN) {
  const child = spawnCli(args, env, bin);
  let stderr = "";
  let stdout = "";
  child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  const code = new Promise<string>((resolve, reject) => {
    child.stderr!.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
      const m = /code ([A-Z]{4}-[A-Z]{4})/.exec(stderr);
      if (m) resolve(m[1]!);
    });
    child.on("close", () => reject(new Error(`join exited before printing a code: ${stderr}`)));
  });
  const exit = new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
  const kill = setTimeout(() => child.kill("SIGKILL"), 20000);
  void exit.then(() => clearTimeout(kill));
  return { code, exit, out: () => stdout, err: () => stderr };
}

test("join --app codex connects <person>-codex and saves its token under apps.codex", async () => {
  const env = isolatedEnv();
  const j = await startJoin(["join", server.url, "--app", "codex"], env);
  const userCode = await j.code;
  assert.ok(j.err().includes(`/device?code=${userCode}&mode=agent&app=codex and confirm code ${userCode}`), j.err());
  await approveDevice(server.db, ana, userCode, ["billing-migration"]);
  assert.equal(await j.exit, 0, j.err());
  assert.match(j.out(), /Joined as ana-codex\./);
  const file = readConfigFile(env);
  assert.equal(file.url, server.url);
  assert.equal(file.token, undefined);
  assert.match(String(file.apps?.codex), /^tk_/);
  assert.equal(statSync(configPath(env)).mode & 0o777, 0o600);
  const who = JSON.parse((await runCli(["whoami", "--json", "--app", "codex"], env)).stdout) as { actor: { name: string } };
  assert.equal(who.actor.name, "ana-codex");
  // A command with no app has no token of its own here.
  assert.equal((await runCli(["whoami"], env)).code, 2);
});

test("TEAMKIT_APP picks the app: one machine keeps ana-claude and ana-codex side by side", async () => {
  const env = isolatedEnv();
  const claude = await startJoin(["join", server.url], { ...env, TEAMKIT_APP: "claude" });
  await approveDevice(server.db, ana, await claude.code, ["billing-migration"]);
  assert.equal(await claude.exit, 0, claude.err());
  assert.match(claude.out(), /Joined as ana-claude\./);
  const codex = await startJoin(["join", server.url, "--app", "codex"], env);
  await approveDevice(server.db, ana, await codex.code, ["billing-prod"]);
  assert.equal(await codex.exit, 0, codex.err());
  const file = readConfigFile(env);
  assert.deepEqual(Object.keys(file.apps ?? {}).sort(), ["claude", "codex"]);
  assert.notEqual(file.apps?.claude, file.apps?.codex);
  const name = async (extra: NodeJS.ProcessEnv, args: string[] = []) =>
    (JSON.parse((await runCli(["whoami", "--json", ...args], { ...env, ...extra })).stdout) as { actor: { name: string } }).actor.name;
  assert.equal(await name({ TEAMKIT_APP: "claude" }), "ana-claude");
  assert.equal(await name({ TEAMKIT_APP: "codex" }), "ana-codex");
  assert.equal(await name({ TEAMKIT_APP: "claude" }, ["--app", "codex"]), "ana-codex");
});

test("a CLI installed under a .codex folder joins and acts as <person>-codex", async () => {
  const env = isolatedEnv();
  const bin = linkedBin(".codex");
  const j = await startJoin(["join", server.url], env, bin);
  await approveDevice(server.db, ana, await j.code, ["billing-migration"]);
  assert.equal(await j.exit, 0, j.err());
  assert.match(j.out(), /Joined as ana-codex\./);
  assert.match(String(readConfigFile(env).apps?.codex), /^tk_/);
  const who = await runCli(["whoami", "--json"], env, { bin });
  assert.equal((JSON.parse(who.stdout) as { actor: { name: string } }).actor.name, "ana-codex", who.stderr);
  const claudeBin = linkedBin(".claude");
  assert.equal((await runCli(["whoami"], env, { bin: claudeBin })).code, 2, "no ana-claude login on this machine yet");
});

test("joining another server drops the old server's agent logins; the same server keeps the others", async () => {
  const other = isolatedEnv();
  writeConfigFile({ url: "https://old.example.com", token: "tk_old", apps: { claude: "tk_old_claude" } }, other);
  const j1 = await startJoin(["join", server.url, "--app", "codex"], other);
  await approveDevice(server.db, ana, await j1.code, ["billing-migration"]);
  assert.equal(await j1.exit, 0, j1.err());
  const moved = readConfigFile(other);
  assert.deepEqual([moved.url, moved.token, Object.keys(moved.apps ?? {})], [server.url, undefined, ["codex"]]);
  assert.match(j1.err(), /Removed the agent logins for https:\/\/old\.example\.com: this machine now uses/);
  const same = isolatedEnv();
  writeConfigFile({ url: server.url, token: "tk_keep", apps: { claude: "tk_keep_claude" } }, same);
  const j2 = await startJoin(["join", server.url, "--app", "codex"], same);
  await approveDevice(server.db, ana, await j2.code, ["billing-migration"]);
  assert.equal(await j2.exit, 0, j2.err());
  const kept = readConfigFile(same);
  assert.deepEqual([kept.token, kept.apps?.claude], ["tk_keep", "tk_keep_claude"]);
  assert.match(String(kept.apps?.codex), /^tk_/);
  assert.doesNotMatch(j2.err(), /Removed/);
});

test("join with an unknown --app exits 2 before asking for a code", async () => {
  const r = await runCli(["join", server.url, "--app", "cursor"], isolatedEnv());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--app must be one of claude, codex/);
  assert.doesNotMatch(r.stderr, /confirm code/);
});
