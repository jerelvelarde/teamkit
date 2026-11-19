import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { after, before, test } from "node:test";
import { approveDevice } from "../../../apps/server/src/store/device.js";
import { personAuth } from "../../../apps/server/test/helpers/actors.js";
import { startTestServer } from "../../../apps/server/test/helpers/server.js";
import { joinServerUrl } from "../src/commands/join.js";
import { configPath, readConfigFile, writeConfigFile } from "../src/config.js";
import { isolatedEnv, runCli, spawnCli } from "./helpers/cli.js";

let server: Awaited<ReturnType<typeof startTestServer>>;
let ana: Awaited<ReturnType<typeof personAuth>>;

before(async () => {
  server = await startTestServer();
  ana = await personAuth(server.db, "ana", "member");
});

after(async () => {
  await server.stop();
});

/** Starts `teamkit <args>`, returns its login code and the exit result. */
async function startJoin(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawnCli(args, env);
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

test("join connects <person>-agent: it saves url and token, and whoami is the agent", async () => {
  const env = isolatedEnv();
  const j = await startJoin(["join", server.url], env);
  const userCode = await j.code;
  await approveDevice(server.db, ana, userCode, ["billing-migration"]);
  assert.equal(await j.exit, 0, j.err());
  assert.ok(j.err().includes(`/device?code=${userCode}&mode=agent and confirm code ${userCode}`), j.err());
  assert.match(j.out(), /Joined as ana-agent\./);
  const file = readConfigFile(env);
  assert.equal(file.url, server.url);
  assert.match(String(file.token), /^tk_/);
  assert.equal(statSync(configPath(env)).mode & 0o777, 0o600);
  const who = JSON.parse((await runCli(["whoami", "--json"], env)).stdout) as { actor: { name: string }; scope: string };
  assert.deepEqual([who.actor.name, who.scope], ["ana-agent", "agent"]);
});

test("a second install gets its own token for the same agent", async () => {
  const tokens: string[] = [];
  for (const rooms of [["billing-migration"], ["billing-prod"]]) {
    const env = isolatedEnv();
    const j = await startJoin(["join", server.url], env);
    await approveDevice(server.db, ana, await j.code, rooms);
    assert.equal(await j.exit, 0, j.err());
    tokens.push(String(readConfigFile(env).token));
  }
  assert.notEqual(tokens[0], tokens[1]);
  for (const token of tokens) {
    const w = await runCli(["whoami", "--json"], isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_TOKEN: token }));
    assert.equal(JSON.parse(w.stdout).actor.name, "ana-agent");
  }
});

test("joinServerUrl takes the origin of a join link and strips trailing slashes", () => {
  assert.equal(joinServerUrl("https://teamkit.example.com/join/jc_abc"), "https://teamkit.example.com");
  assert.equal(joinServerUrl("https://teamkit.example.com/"), "https://teamkit.example.com");
  assert.equal(joinServerUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  for (const bad of ["teamkit.example.com", "ftp://teamkit.example.com"]) assert.throws(() => joinServerUrl(bad), /not an http\(s\) URL/);
});

test("joining another server removes the old server's admin login; the same server keeps it", async () => {
  const other = isolatedEnv();
  writeConfigFile({ url: "https://old.example.com", adminToken: "tk_old" }, other);
  const j1 = await startJoin(["join", `${server.url}/join/jc_abc`], other);
  await approveDevice(server.db, ana, await j1.code, ["billing-migration"]);
  assert.equal(await j1.exit, 0, j1.err());
  assert.equal(readConfigFile(other).adminToken, undefined);
  assert.equal(readConfigFile(other).url, server.url);
  assert.match(j1.err(), /Removed the admin login for https:\/\/old\.example\.com: this machine now uses/);
  const same = isolatedEnv();
  writeConfigFile({ url: server.url, adminToken: "tk_keep" }, same);
  const j2 = await startJoin(["join", server.url], same);
  await approveDevice(server.db, ana, await j2.code, ["billing-migration"]);
  assert.equal(await j2.exit, 0, j2.err());
  assert.equal(readConfigFile(same).adminToken, "tk_keep");
});

test("join warns when TEAMKIT_TOKEN in the shell would override the saved token", async () => {
  const j = await startJoin(["join", server.url], isolatedEnv({ TEAMKIT_TOKEN: "tk_shell" }));
  await approveDevice(server.db, ana, await j.code, ["billing-migration"]);
  assert.equal(await j.exit, 0, j.err());
  assert.match(j.err(), /TEAMKIT_TOKEN is set in this shell and overrides the saved token; unset it to act as ana-agent\./);
});

test("an unapproved join expires and exits 1; join without a URL exits 2", async () => {
  const prev = process.env.TEAMKIT_DEVICE_TTL_MS;
  process.env.TEAMKIT_DEVICE_TTL_MS = "300";
  try {
    const r = await runCli(["join", server.url], isolatedEnv(), { timeoutMs: 15000 });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /join code expired; run `teamkit join .+` again/);
  } finally {
    if (prev === undefined) delete process.env.TEAMKIT_DEVICE_TTL_MS;
    else process.env.TEAMKIT_DEVICE_TTL_MS = prev;
  }
  assert.equal((await runCli(["join"], isolatedEnv())).code, 2);
});
