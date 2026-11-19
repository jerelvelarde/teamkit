import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { agentToken, startTestServer } from "../../../apps/server/test/helpers/server.js";
import { personAuth } from "../../../apps/server/test/helpers/actors.js";
import { approveDevice, pollDevice, startDevice } from "../../../apps/server/src/store/device.js";
import { isolatedEnv, runCli } from "./helpers/cli.js";

let server: Awaited<ReturnType<typeof startTestServer>>;
let adminToken: string;
let memberToken: string;
let agent: string;

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
  agent = await agentToken(server.db, "fixture");
});
after(async () => {
  await server.stop();
});

const adminEnv = () => isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_ADMIN_TOKEN: adminToken });

test("tokens create prints name and token per line; the tokens work; list and revoke", async () => {
  const env = adminEnv();
  const r = await runCli(["tokens", "create", "worker", "--rooms", "build:read,post", "--count", "2"], env);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  lines.forEach((l, i) => assert.match(l, new RegExp(`^worker-${i + 1}\\ttk_[A-Za-z0-9_-]{43}$`)));
  for (const l of lines) {
    const token = l.split("\t")[1]!;
    const w = await runCli(["whoami", "--json"], isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_TOKEN: token }));
    assert.equal(w.code, 0, w.stderr);
    assert.equal(JSON.parse(w.stdout).actor.name, lines.indexOf(l) === 0 ? "worker-1" : "worker-2");
  }

  const list = await runCli(["tokens", "list"], env);
  assert.equal(list.code, 0, list.stderr);
  const rows = list.stdout.trim().split("\n").map((l) => l.split("\t"));
  const w1 = rows.find((c) => c[1] === "worker-1");
  assert.ok(w1, list.stdout);
  assert.deepEqual([w1[2], w1[3]], ["agent", "active"]);

  const rev = await runCli(["tokens", "revoke", w1[0]!], env);
  assert.equal(rev.code, 0, rev.stderr);
  assert.equal(rev.stdout.trim(), "revoked");
  const again = await runCli(["tokens", "list"], env);
  assert.match(again.stdout, /worker-1\tagent\trevoked/);
});

test("tokens create --json prints the created tokens", async () => {
  const r = await runCli(["tokens", "create", "bot", "--rooms", "a:read", "--rooms", "b:post", "--json"], adminEnv());
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.length, 1);
  assert.match(out[0].token, /^tk_/);
});

test("rooms set stores approvers", async () => {
  const r = await runCli(["rooms", "set", "build", "--approvers", "ada,bob"], adminEnv());
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).approvers, ["ada", "bob"]);
  const c = await runCli(["rooms", "set", "build", "--approvers", "none", "--agent", "none"], adminEnv());
  assert.equal(c.code, 0, c.stderr);
  assert.equal(JSON.parse(c.stdout).approvers, null);
});

test("rooms with an agent token still lists rooms", async () => {
  const r = await runCli(["rooms"], isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_TOKEN: agent }));
  assert.equal(r.code, 0, r.stderr);
});

test("a member's admin token is forbidden", async () => {
  const r = await runCli(["tokens", "list"], isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_ADMIN_TOKEN: memberToken }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /forbidden/);
});

test("without an admin token it exits 2 and points at teamkit login", async () => {
  const r = await runCli(["tokens", "list"], isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_TOKEN: agent }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /teamkit login/);
});

test("an empty permission list exits 2", async () => {
  const r = await runCli(["tokens", "create", "x", "--rooms", "build:"], adminEnv());
  assert.equal(r.code, 2);
});

test("people list shows ada; people invite does not exist", async () => {
  const list = await runCli(["people", "list"], adminEnv());
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^ada\tadmin\t(never|\d{4}-)/m);
  const inv = await runCli(["people", "invite", "bob"], adminEnv());
  assert.equal(inv.code, 2);
});

test("rooms set --reservation-minutes sends the hold length", async () => {
  const r = await runCli(["rooms", "set", "billing-prod", "--reservation-minutes", "45"], adminEnv());
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).reservationMinutes, 45);
  const bad = await runCli(["rooms", "set", "billing-prod", "--reservation-minutes", "soon"], adminEnv());
  assert.equal(bad.code, 2);
});
