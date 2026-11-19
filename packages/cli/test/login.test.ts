import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { after, before, test } from "node:test";
import { createAdminClient } from "@copilotkit/teamkit-client";
import { approveDevice } from "../../../apps/server/src/store/device.js";
import { personAuth } from "../../../apps/server/test/helpers/actors.js";
import { startTestServer } from "../../../apps/server/test/helpers/server.js";
import { configPath } from "../src/config.js";
import { isolatedEnv, runCli, spawnCli } from "./helpers/cli.js";

let server: Awaited<ReturnType<typeof startTestServer>>;
let ada: Awaited<ReturnType<typeof personAuth>>;

before(async () => {
  server = await startTestServer();
  ada = await personAuth(server.db, "ada", "admin");
});
after(async () => {
  await server.stop();
});

/** Starts `teamkit login`, returns the child, its login code and the exit result. */
async function startLogin(env: NodeJS.ProcessEnv) {
  const child = spawnCli(["login"], env);
  let stderr = "";
  let stdout = "";
  child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  const code = new Promise<string>((resolve, reject) => {
    child.stderr!.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
      const m = /code ([A-Z]{4}-[A-Z]{4})/.exec(stderr);
      if (m) resolve(m[1]!);
    });
    child.on("close", () => reject(new Error(`login exited before printing a code: ${stderr}`)));
  });
  const exit = new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
  const kill = setTimeout(() => child.kill("SIGKILL"), 20000);
  void exit.then(() => clearTimeout(kill));
  return { code, exit, out: () => stdout, err: () => stderr };
}

test("login, whoami with the admin token, then logout", async () => {
  const env = isolatedEnv({ TEAMKIT_URL: server.url });
  const login = await startLogin(env);
  await approveDevice(server.db, ada, await login.code);
  assert.equal(await login.exit, 0, login.err());
  assert.match(login.out(), /Signed in as ada\. This login runs admin commands only\./);

  const file = JSON.parse(readFileSync(configPath(env), "utf8")) as Record<string, unknown>;
  assert.match(String(file.adminToken), /^tk_/);
  assert.equal(file.token, undefined);
  assert.equal(statSync(configPath(env)).mode & 0o777, 0o600);

  const adminToken = String(file.adminToken);
  const who = await createAdminClient({ url: server.url, token: adminToken }).whoami();
  assert.equal(who.scope, "admin");

  const out = await runCli(["logout"], env);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /Signed out/);
  await assert.rejects(createAdminClient({ url: server.url, token: adminToken }).whoami());
  const after = JSON.parse(readFileSync(configPath(env), "utf8")) as Record<string, unknown>;
  assert.equal(after.adminToken, undefined);
  assert.equal(after.url, server.url);

  const again = await runCli(["logout"], env);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /Not signed in/);
});

test("an unapproved login expires and exits 1", async () => {
  const prev = process.env.TEAMKIT_DEVICE_TTL_MS;
  process.env.TEAMKIT_DEVICE_TTL_MS = "300";
  try {
    const started = Date.now();
    const r = await runCli(["login"], isolatedEnv({ TEAMKIT_URL: server.url }), { timeoutMs: 15000 });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /login code expired/);
    assert.ok(Date.now() - started < 5000 + 3000, "expired within about 5 s");
  } finally {
    if (prev === undefined) delete process.env.TEAMKIT_DEVICE_TTL_MS;
    else process.env.TEAMKIT_DEVICE_TTL_MS = prev;
  }
});

test("login without a URL exits 2", async () => {
  const r = await runCli(["login"], isolatedEnv());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /TEAMKIT_URL/);
});
