import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@copilotkit/teamkit-client";
import { startTestServer } from "../../../apps/server/test/helpers/server.js";
import { BRIEF, billingTeam, type TeamAgent } from "../../../apps/server/test/helpers/team.js";
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
