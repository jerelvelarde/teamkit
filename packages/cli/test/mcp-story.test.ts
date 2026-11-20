import { test } from "node:test";
import assert from "node:assert/strict";
import { TeamkitError } from "@copilotkit/teamkit-client";
import { answer } from "../../../apps/server/src/store/blocks.js";
import { isolatedEnv } from "./helpers/cli.js";
import { connectMcp, mcpTeam } from "./helpers/mcp.js";

test("two agents and sam run the billing backfill through MCP", async () => {
  const { srv, team, anaToken, benToken, anaClient, benClient } = await mcpTeam();
  const ana = await connectMcp(isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: anaToken }));
  const ben = await connectMcp(isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: benToken }));
  try {
    // 1. ana-agent starts the backfill and hands it to ben-agent.
    const id = (await ana.call("teamkit_create_task", { room: "billing-prod", brief: "Backfill invoices into billing-v2" })).text.split("\t")[0]!;
    assert.match((await ana.call("teamkit_claim", { taskId: id })).text, /^Claimed /);
    assert.equal((await ana.call("teamkit_reply", { threadId: id, text: "Plan: pause the invoice sync, backfill in batches, compare counts." })).text, "ok");
    assert.match((await ana.call("teamkit_handoff", { taskId: id, to: "ben-agent" })).text, /held for ben-agent/);

    // 2. ben-agent picks it up, pauses the sync and asks sam.
    assert.match((await ben.call("teamkit_pending")).text, new RegExp(id));
    assert.match((await ben.call("teamkit_claim", { taskId: id })).text, /^Claimed /);
    assert.match((await ben.call("teamkit_log_change", { room: "billing-prod", taskId: id, what: "Paused the invoice sync job",
      where: "billing-prod invoice sync", undo: "Resume the invoice sync job", undoWhen: "after the backfill is verified" })).text, /^Logged change chg_/);
    assert.equal((await ben.call("teamkit_reply", { threadId: id, text: "Recommend running the backfill tonight; it takes about 40 minutes." })).text, "ok");
    const asked = await ben.call("teamkit_ask", { taskId: id, question: "Run the invoice backfill on billing-prod tonight?",
      kind: "awaiting_approval", approvers: ["sam"] });
    assert.match(asked.text, /blocked waiting on sam$/);

    // 3. No agent can answer it.
    assert.ok(!(await ben.names()).includes("teamkit_answer"));
    await assert.rejects(benClient.answer(id, { text: "approved" }),
      (e) => e instanceof TeamkitError && e.code === "approval_requires_person");

    // 4. sam approves.
    await answer(srv.db, team.sam.auth, id, { text: "Approved for tonight" });

    // 5. ben-agent sees the answer, runs the backfill, restores the sync and completes.
    assert.match((await ben.call("teamkit_pending")).text, new RegExp(id));
    assert.match((await ben.call("teamkit_claim", { taskId: id })).text, /^Claimed /);
    const [change] = await anaClient.changes("billing-prod");
    assert.equal((await ben.call("teamkit_update_change", { changeId: change!.id, status: "restored" })).text, `Change ${change!.id} is restored`);
    assert.equal((await ben.call("teamkit_complete", { taskId: id,
      result: "Backfilled 1.2M invoices into billing-v2; counts match; invoice sync resumed." })).text, `${id}\tcompleted`);

    // 6. The board agrees, and no tool text carried a token.
    assert.equal((await anaClient.thread(id)).task?.state, "completed");
    assert.equal((await anaClient.changes("billing-prod"))[0]!.status, "restored");
    for (const text of [...ana.transcript, ...ben.transcript]) {
      assert.ok(!text.includes(anaToken) && !text.includes(benToken), text);
    }
  } finally {
    await ana.close();
    await ben.close();
    await srv.stop();
  }
});
