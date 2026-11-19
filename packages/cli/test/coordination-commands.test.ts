import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@copilotkit/teamkit-client";
import { startTestServer } from "../../../apps/server/test/helpers/server.js";
import { BRIEF, FREEZE, billingTeam, type TeamAgent } from "../../../apps/server/test/helpers/team.js";
import { isolatedEnv, runCli } from "./helpers/cli.js";

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
