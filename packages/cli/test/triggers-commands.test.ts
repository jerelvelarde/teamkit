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

test("add a webhook prints the secret once; list, disable and remove follow", async () => {
  const env = adminEnv();
  const add = await runCli(
    ["triggers", "add", "hook", "--room", "build", "--kinds", "task.completed,task.failed", "--label", "team=a", "--webhook", "http://127.0.0.1:9/h"],
    env,
  );
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /^added hook$/m);
  assert.match(add.stdout, /^secret\twhsec_\S+$/m);

  const list = await runCli(["triggers", "list"], env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^hook\tbuild\ttask\.completed,task\.failed\twebhook http:\/\/127\.0\.0\.1:9\/h\tenabled$/m);
  assert.ok(!list.stdout.includes("whsec_"));

  const off = await runCli(["triggers", "disable", "hook"], env);
  assert.equal(off.code, 0, off.stderr);
  assert.match((await runCli(["triggers", "list"], env)).stdout, /\tdisabled$/m);
  const on = await runCli(["triggers", "enable", "hook"], env);
  assert.equal(on.code, 0, on.stderr);
  assert.match((await runCli(["triggers", "list"], env)).stdout, /\tenabled$/m);

  const rm = await runCli(["triggers", "remove", "hook"], env);
  assert.equal(rm.code, 0, rm.stderr);
  assert.equal((await runCli(["triggers", "list"], env)).stdout.trim(), "");
});

test("--json add returns the CreatedTrigger", async () => {
  const r = await runCli(
    ["triggers", "add", "jhook", "--room", "*", "--kinds", "task.ready", "--webhook", "http://127.0.0.1:9/j", "--json"],
    adminEnv(),
  );
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.trigger.name, "jhook");
  assert.match(out.secret, /^whsec_/);
});

test("a bad kind exits 2", async () => {
  const r = await runCli(["triggers", "add", "bad", "--room", "build", "--kinds", "task.nope", "--webhook", "http://127.0.0.1:9/b"], adminEnv());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown event kind/);
});

test("both or neither of --webhook and --agent exits 2", async () => {
  const env = adminEnv();
  const both = await runCli(["triggers", "add", "x", "--room", "a", "--kinds", "task.ready", "--webhook", "http://127.0.0.1:9/x", "--agent", "ag"], env);
  assert.equal(both.code, 2);
  const neither = await runCli(["triggers", "add", "x", "--room", "a", "--kinds", "task.ready"], env);
  assert.equal(neither.code, 2);
});

test("a member's admin token is forbidden", async () => {
  const r = await runCli(["triggers", "list"], isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_ADMIN_TOKEN: memberToken }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /forbidden/);
});
