import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestServer } from "../../../apps/server/test/helpers/server.js";
import { personAuth } from "../../../apps/server/test/helpers/actors.js";
import { approveDevice, pollDevice, startDevice } from "../../../apps/server/src/store/device.js";
import { isolatedEnv, runCli } from "./helpers/cli.js";

let server: Awaited<ReturnType<typeof startTestServer>>;
let adminToken: string;
let memberToken: string;

async function deviceToken(auth: Awaited<ReturnType<typeof personAuth>>): Promise<string> {
  const d = await startDevice(server.db);
  await approveDevice(server.db, auth, d.userCode);
  const got = await pollDevice(server.db, d.deviceCode);
  assert.equal(got.status, "approved");
  return got.status === "approved" ? got.token : "";
}

before(async () => {
  server = await startTestServer();
  adminToken = await deviceToken(await personAuth(server.db, "ada", "admin"));
  memberToken = await deviceToken(await personAuth(server.db, "mel", "member"));
});
after(async () => {
  await server.stop();
});

const adminEnv = () => isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_ADMIN_TOKEN: adminToken });

test("register then list shows the agent; disable and enable flip it", async () => {
  const env = adminEnv();
  const reg = await runCli(["agents", "register", "approver", "--agent-url", "http://127.0.0.1:9/agent", "--rooms", "build,ops"], env);
  assert.equal(reg.code, 0, reg.stderr);
  assert.equal(reg.stdout.trim(), "registered approver");

  const list = await runCli(["agents", "list"], env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^approver\thttp:\/\/127\.0\.0\.1:9\/agent\tbuild,ops\tenabled$/m);

  const off = await runCli(["agents", "disable", "approver"], env);
  assert.equal(off.code, 0, off.stderr);
  assert.match(off.stdout, /disabled/);
  assert.match((await runCli(["agents", "list"], env)).stdout, /\tdisabled$/m);

  const on = await runCli(["agents", "enable", "approver"], env);
  assert.equal(on.code, 0, on.stderr);
  assert.match((await runCli(["agents", "list"], env)).stdout, /\tenabled$/m);
});

test("--header values are stored but only names come back", async () => {
  const secret = "s3cret-header-value";
  const r = await runCli(
    ["agents", "register", "keyed", "--agent-url", "http://127.0.0.1:9/k", "--rooms", "build", "--header", `Authorization=${secret}`, "--json"],
    adminEnv(),
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).headerNames, ["Authorization"]);
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
  const list = await runCli(["agents", "list", "--json"], adminEnv());
  assert.ok(!list.stdout.includes(secret));
});

test("a member's admin token is forbidden", async () => {
  const r = await runCli(["agents", "list"], isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_ADMIN_TOKEN: memberToken }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /forbidden/);
});

test("a malformed --header exits 2 without echoing the value", async () => {
  const r = await runCli(["agents", "register", "bad", "--agent-url", "http://127.0.0.1:9/x", "--rooms", "a", "--header", "nope"], adminEnv());
  assert.equal(r.code, 2);
  assert.ok(!r.stderr.includes("nope="));
});
