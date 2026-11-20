import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@copilotkit/teamkit-client";
import { startTestServer } from "../../../apps/server/test/helpers/server.js";
import { BRIEF, FREEZE, billingTeam, type TeamAgent } from "../../../apps/server/test/helpers/team.js";
import { isolatedEnv, runCli } from "./helpers/cli.js";
import { createServer, type Server } from "node:net";
import { randomBytes } from "node:crypto";
import { writeConfigFile } from "../src/config.js";

async function setup() {
  const srv = await startTestServer();
  const team = await billingTeam(srv.db);
  const env = (a: TeamAgent) => isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: a.token });
  const client = (a: TeamAgent) => createClient({ url: srv.url, token: a.token });
  return { srv, team, env, client };
}

test("tasks block --approvers names who must answer", async () => {
  const { srv, team, env, client } = await setup();
  try {
    const ben = client(team.benAgent);
    const task = await ben.createTask({ room: "billing-prod", brief: BRIEF });
    const claim = await ben.claim(task.id);
    const r = await runCli(["tasks", "block", task.id, "Run the backfill on billing-prod?", "--kind", "awaiting_approval",
      "--approvers", "sam", "--claim", claim.claimId], env(team.benAgent));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), `${task.id}\tblocked`);
    const list = await runCli(["tasks", "list", "billing-prod"], env(team.benAgent));
    assert.ok(list.stdout.includes("(waiting on sam)"), list.stdout);
  } finally {
    await srv.stop();
  }
});

test("handoff prints the hold and forgets the stored claim", async () => {
  const { srv, team, env } = await setup();
  try {
    const e = env(team.benAgent);
    const created = await runCli(["tasks", "create", "billing-migration", BRIEF, "--json"], e);
    assert.equal(created.code, 0, created.stderr);
    const id = (JSON.parse(created.stdout) as { id: string }).id;
    const claimed = await runCli(["tasks", "claim", id], e);
    assert.equal(claimed.code, 0, claimed.stderr);
    const r = await runCli(["handoff", id, "sam-agent"], e);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^th_\S+\theld for sam-agent until \S+Z\n$/);
    assert.equal((await runCli(["tasks", "complete", id], e)).code, 2);
  } finally {
    await srv.stop();
  }
});

test("decide --for the owner, then ack", async () => {
  const { srv, team, env } = await setup();
  try {
    const d = await runCli(["decide", "billing-migration", FREEZE, "--for", "ana"], env(team.anaAgent));
    assert.equal(d.code, 0, d.stderr);
    assert.match(d.stdout, /^dec_\S+\tth_\S+\n$/);
    const decId = d.stdout.split("\t")[0]!;
    const a = await runCli(["ack", decId], env(team.benAgent));
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.stdout, `${decId}\tacked\n`);
    const bad = await runCli(["decide", "billing-migration", FREEZE], env(team.anaAgent));
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /invalid_input/);
  } finally {
    await srv.stop();
  }
});

test("rollcall starts one and rollcall answer answers it", async () => {
  const { srv, team, env } = await setup();
  try {
    const r = await runCli(["rollcall", "billing-migration"], env(team.anaAgent));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^rc_\S+\tth_\S+\n$/);
    const rcId = r.stdout.split("\t")[0]!;
    const a = await runCli(["rollcall", "answer", rcId, "on: watching billing-prod"], env(team.benAgent));
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.stdout, `${rcId}\tanswered\n`);
  } finally {
    await srv.stop();
  }
});

test("presence prints the agents on in a room", async () => {
  const { srv, team, env, client } = await setup();
  try {
    await client(team.benAgent).heartbeat({ watching: ["billing-migration"], status: "idle" });
    const r = await runCli(["presence", "billing-migration"], env(team.anaAgent));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^ben-agent  ben  on  1 session  last seen \S+  watching billing-migration  idle\n$/);
  } finally {
    await srv.stop();
  }
});

const ADD_COLUMN = { what: "Added column invoices.currency_code", where: "billing-prod database",
  undo: "alter table invoices drop column currency_code", undoWhen: "if the backfill fails" };

test("log records a change and change updates its status", async () => {
  const { srv, team, env, client } = await setup();
  try {
    const task = await client(team.benAgent).createTask({ room: "billing-prod", brief: BRIEF });
    const e = env(team.benAgent);
    const r = await runCli(["log", "billing-prod", "--what", ADD_COLUMN.what, "--where", ADD_COLUMN.where, "--undo", ADD_COLUMN.undo,
      "--undo-when", ADD_COLUMN.undoWhen, "--task", task.id], e);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^chg_\S+\tactive\n$/);
    const chgId = r.stdout.split("\t")[0]!;
    assert.equal((await runCli(["change", chgId, "done"], e)).stdout, `${chgId}\tdone\n`);
    assert.equal((await runCli(["change", chgId, "undone"], e)).code, 2);
    assert.equal((await runCli(["log", "billing-prod", "--what", "x"], e)).code, 2);
  } finally {
    await srv.stop();
  }
});

const GAP = "invoices_v2 row count is 0.5% below invoices_v1";

test("alert raises; alert confirm and alert resolve --source name the owner", async () => {
  const { srv, team, env } = await setup();
  try {
    const e = env(team.benAgent);
    const r = await runCli(["alert", "billing-prod", GAP], e);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^alr_\S+\tsuspected\n$/);
    const id = r.stdout.split("\t")[0]!;
    const confirmed = await runCli(["alert", "confirm", id, "--source", "ben"], e);
    assert.equal(confirmed.stdout, `${id}\tconfirmed\n`, confirmed.stderr);
    const resolved = await runCli(["alert", "resolve", id, "--source", "ben"], e);
    assert.equal(resolved.stdout, `${id}\tresolved\n`, resolved.stderr);
  } finally {
    await srv.stop();
  }
});

test("pending --brief prints nothing when nothing waits, and the handoff when one does", async () => {
  const { srv, team, env, client } = await setup();
  try {
    const quiet = await runCli(["pending", "--brief"], env(team.benAgent));
    assert.deepEqual([quiet.code, quiet.stdout], [0, ""], quiet.stderr);
    const task = await client(team.anaAgent).createTask({ room: "billing-migration", brief: "Write the cutover runbook" });
    await client(team.anaAgent).handoff(task.id, "ben-agent");
    const r = await runCli(["pending", "--brief"], env(team.benAgent));
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.startsWith("TeamKit: 1 waiting for you\nhandoff  "), r.stdout);
    const full = await runCli(["pending"], env(team.benAgent));
    assert.ok(full.stdout.startsWith(`handoff  ${task.id}  billing-migration  Write the cutover runbook  (held until `), full.stdout);
  } finally {
    await srv.stop();
  }
});

// The hook-safe cases. A UserPromptSubmit hook that exits 2 drops the person's prompt, so none of these may exit 2.
test("pending --brief with no login prints nothing and exits 0", async () => {
  const r = await runCli(["pending", "--brief"], isolatedEnv());
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
});

test("pending --brief with only an admin login prints nothing and exits 0", async () => {
  const env = isolatedEnv();
  writeConfigFile({ url: "http://127.0.0.1:9", adminToken: "tk_admin_only" }, env); // what `teamkit login` leaves
  const r = await runCli(["pending", "--brief"], env);
  assert.deepEqual([r.code, r.stdout], [0, ""], r.stderr);
});

test("pending --brief gives up on a server that never answers: exit 1, one stderr line, within 7 s", async () => {
  const hang: Server = createServer(() => {});
  await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", resolve));
  const port = (hang.address() as { port: number }).port;
  try {
    const start = Date.now();
    const r = await runCli(["pending", "--brief"], isolatedEnv({ TEAMKIT_URL: `http://127.0.0.1:${port}`, TEAMKIT_TOKEN: "tk_unused" }));
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.ok(Date.now() - start < 7000);
  } finally {
    hang.close();
  }
});

test("pending --brief with a server that is down, or a token it does not know, exits 1 and never prints the token", async () => {
  const down = await runCli(["pending", "--brief"], isolatedEnv({ TEAMKIT_URL: "http://127.0.0.1:9", TEAMKIT_TOKEN: "tk_x" }));
  assert.deepEqual([down.code, down.stdout], [1, ""], down.stderr);
  assert.equal(down.stderr.trim().split("\n").length, 1, down.stderr);
  const srv = await startTestServer();
  try {
    const token = "tk_" + randomBytes(16).toString("hex");
    const r = await runCli(["pending", "--brief"], isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: token }));
    assert.deepEqual([r.code, r.stdout], [1, ""], r.stderr);
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.ok(!r.stderr.includes(token));
  } finally {
    await srv.stop();
  }
});

test("pending --brief uses the app's saved token; an unknown TEAMKIT_APP exits 1 with one line, never 2", async () => {
  const { srv, team, client } = await setup();
  try {
    const env = isolatedEnv();
    writeConfigFile({ url: srv.url, token: team.anaAgent.token, apps: { claude: team.benAgent.token } }, env);
    const task = await client(team.anaAgent).createTask({ room: "billing-migration", brief: "Write the cutover runbook" });
    await client(team.anaAgent).handoff(task.id, "ben-agent");
    const asBen = await runCli(["pending", "--brief"], { ...env, TEAMKIT_APP: "claude" });
    assert.equal(asBen.code, 0, asBen.stderr);
    assert.ok(asBen.stdout.startsWith("TeamKit: 1 waiting for you\nhandoff  "), asBen.stdout);
    const asAna = await runCli(["pending", "--brief"], env);
    assert.deepEqual([asAna.code, asAna.stdout], [0, ""], asAna.stderr);
    const bad = await runCli(["pending", "--brief"], { ...env, TEAMKIT_APP: "cursor" });
    assert.deepEqual([bad.code, bad.stdout], [1, ""]);
    assert.equal(bad.stderr.trim().split("\n").length, 1, bad.stderr);
    assert.match(bad.stderr, /TEAMKIT_APP must be one of claude, codex/);
  } finally {
    await srv.stop();
  }
});
