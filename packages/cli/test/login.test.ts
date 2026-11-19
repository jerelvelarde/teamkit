import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createAdminClient } from "@copilotkit/teamkit-client";
import { approveDevice, pollDevice, startDevice } from "../../../apps/server/src/store/device.js";
import { personAuth } from "../../../apps/server/test/helpers/actors.js";
import { startTestServer } from "../../../apps/server/test/helpers/server.js";
import { configPath, readConfigFile, writeConfigFile } from "../src/config.js";
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

/** A fresh admin login for ada, minted through the device store. */
async function adminLogin(): Promise<string> {
  const d = await startDevice(server.db);
  await approveDevice(server.db, ada, d.userCode);
  const got = await pollDevice(server.db, d.deviceCode);
  assert.equal(got.status, "approved");
  return got.status === "approved" ? got.token : "";
}

const isLive = async (token: string): Promise<boolean> =>
  createAdminClient({ url: server.url, token }).whoami().then(
    () => true,
    () => false,
  );

/** A stand-in server that answers every request with `status`, or never answers when `status` is null. */
async function stubServer(status: number | null) {
  let hits = 0;
  const srv = createServer((_req, res) => {
    hits++;
    if (status === null) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: status === 403 ? "forbidden" : "internal", message: "nope" } }));
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        srv.closeAllConnections();
        srv.close(() => resolve());
      }),
  };
}

const REVOKE_FAILED = "Could not revoke the admin token; revoke it on the admin page.";

for (const status of [500, 403]) {
  test(`logout keeps the saved login and exits 1 when the server answers ${status}`, async () => {
    const stub = await stubServer(status);
    try {
      const env = isolatedEnv();
      writeConfigFile({ url: stub.url, adminToken: "tk_still_valid" }, env);
      const r = await runCli(["logout"], env);
      assert.equal(r.code, 1, r.stderr);
      assert.ok(r.stderr.includes(REVOKE_FAILED), r.stderr);
      assert.doesNotMatch(r.stdout, /Signed out/);
      assert.equal(stub.hits(), 1);
      assert.equal(readConfigFile(env).adminToken, "tk_still_valid");
    } finally {
      await stub.close();
    }
  });
}

test("logout keeps the saved login and exits 1 when revoking times out", async () => {
  const stub = await stubServer(null);
  try {
    const env = isolatedEnv();
    writeConfigFile({ url: stub.url, adminToken: "tk_still_valid" }, env);
    const r = await runCli(["logout"], env, { timeoutMs: 40_000 });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /timeout/);
    assert.ok(r.stderr.includes(REVOKE_FAILED), r.stderr);
    assert.equal(readConfigFile(env).adminToken, "tk_still_valid");
  } finally {
    await stub.close();
  }
});

test("logout removes a saved login the server already rejects (401)", async () => {
  const env = isolatedEnv();
  writeConfigFile({ url: server.url, adminToken: "tk_not_a_real_token" }, env);
  const r = await runCli(["logout"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Signed out/);
  assert.equal(readConfigFile(env).adminToken, undefined);
});

test("with TEAMKIT_ADMIN_TOKEN set, logout revokes it and the different saved login", async () => {
  const saved = await adminLogin();
  const fromEnv = await adminLogin();
  const env = isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_ADMIN_TOKEN: fromEnv });
  writeConfigFile({ adminToken: saved }, env);
  assert.ok((await isLive(saved)) && (await isLive(fromEnv)));
  const r = await runCli(["logout"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Signed out/);
  assert.equal(await isLive(saved), false);
  assert.equal(await isLive(fromEnv), false);
  assert.equal(readConfigFile(env).adminToken, undefined);
});

test("login and logout refuse to run inside `teamkit run`", async () => {
  const saved = await adminLogin();
  for (const key of ["TEAMKIT_TASK", "TEAMKIT_CLAIM"]) {
    const env = isolatedEnv({ TEAMKIT_URL: server.url, [key]: "x" });
    writeConfigFile({ adminToken: saved }, env);
    for (const args of [["login"], ["logout"]]) {
      const r = await runCli(args, env);
      assert.equal(r.code, 2, `${args[0]} with ${key}: ${r.stderr}`);
      assert.match(r.stderr, /admin commands are disabled inside `teamkit run`/);
    }
    assert.equal(readConfigFile(env).adminToken, saved);
  }
  assert.equal(await isLive(saved), true);
});
