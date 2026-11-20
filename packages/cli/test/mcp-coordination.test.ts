import { test } from "node:test";
import assert from "node:assert/strict";
import { boardToolDefinitions } from "@copilotkit/teamkit-protocol";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createLeases } from "../src/mcp/leases.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createSession } from "../src/mcp/session.js";
import { MCP_TOOL_NAMES } from "../src/mcp/tools.js";
import { isolatedEnv } from "./helpers/cli.js";
import { connectMcp, mcpTeam, type McpHandle, type McpTeam } from "./helpers/mcp.js";

async function withAgents(fn: (t: McpTeam & { ana: McpHandle; ben: McpHandle }) => Promise<void>): Promise<void> {
  const t = await mcpTeam();
  const ana = await connectMcp(isolatedEnv({ TEAMKIT_URL: t.srv.url, TEAMKIT_TOKEN: t.anaToken }));
  const ben = await connectMcp(isolatedEnv({ TEAMKIT_URL: t.srv.url, TEAMKIT_TOKEN: t.benToken }));
  try {
    await fn({ ...t, ana, ben });
  } finally {
    await ana.close();
    await ben.close();
    await t.srv.stop();
  }
}

test("lists exactly the index's 17 tools, and none that answers, confirms or resolves", async () => {
  await withAgents(async ({ ana }) => {
    assert.deepEqual((await ana.names()).sort(), [...MCP_TOOL_NAMES].sort());
    assert.equal(MCP_TOOL_NAMES.length, 17);
    for (const n of await ana.names()) assert.doesNotMatch(n, /^teamkit_(answer|confirm|resolve)/);
  });
});

test("tools shared with the board tools keep their required parameters", async () => {
  const env = isolatedEnv();
  const server = createMcpServer({ session: createSession({ env }), leases: createLeases(env) }, { version: "test" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "teamkit-test", version: "test" });
  await client.connect(c);
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ["teamkit_create_task", "teamkit_reply"]) {
      const board = boardToolDefinitions.find((t) => t.name === name)!;
      const mine = tools.find((t) => t.name === name)!;
      const required = new Set((mine.inputSchema as { required?: string[] }).required ?? []);
      const boardRequired = (board.parameters as { required?: string[] }).required ?? [];
      assert.ok(boardRequired.length > 0, name);
      for (const r of boardRequired) assert.ok(required.has(r), `${name}.${r}`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("ana-agent records a decision ana made; ben-agent acknowledges it", async () => {
  await withAgents(async ({ ana, ben, anaClient }) => {
    const r = await ana.call("teamkit_decide", { room: "billing-migration", text: "Cut billing reads over to billing-v2 on Friday", decidedBy: "ana" });
    const [d] = await anaClient.decisions("billing-migration");
    assert.equal(r.text, `Decision ${d!.id} recorded for ana`);
    assert.equal(d!.decidedBy.name, "ana");
    assert.equal(d!.postedBy.name, "ana-agent");
    const ack = await ben.call("teamkit_ack", { decisionId: d!.id });
    assert.deepEqual(ack, { text: `Acknowledged ${d!.id}`, isError: false });
    assert.deepEqual((await anaClient.decisions("billing-migration"))[0]!.acks.map((a) => a.actor.name), ["ben-agent"]);
  });
});

test("ben-agent cannot record a decision as ana", async () => {
  await withAgents(async ({ ben }) => {
    const r = await ben.call("teamkit_decide", { room: "billing-migration", text: "Skip the dry run", decidedBy: "ana" });
    assert.equal(r.isError, true);
  });
});

test("ana-agent starts a roll call; ben-agent sees it waiting and answers it", async () => {
  await withAgents(async ({ ana, ben, anaClient }) => {
    const started = await ana.call("teamkit_rollcall_start", { room: "billing-migration" });
    const [rc] = await anaClient.rollCalls("billing-migration");
    assert.equal(started.text, `Roll call ${rc!.id} started in billing-migration`);
    assert.equal(rc!.askedBy.name, "ana-agent");
    assert.match((await ben.call("teamkit_pending")).text, new RegExp(rc!.id));
    const answered = await ben.call("teamkit_rollcall_answer", { rollCallId: rc!.id, status: "on, watching billing-migration" });
    assert.equal(answered.text, `Answered roll call ${rc!.id}`);
    assert.equal((await anaClient.rollCalls("billing-migration"))[0]!.answers[0]!.status, "on, watching billing-migration");
  });
});

test("logs a change with its undo, then marks it done", async () => {
  await withAgents(async ({ ben, anaClient }) => {
    const logged = await ben.call("teamkit_log_change", { room: "billing-prod", what: "Paused the invoice sync job",
      where: "billing-prod invoice sync", undo: "Resume the invoice sync job", undoWhen: "after the backfill is verified" });
    const [c] = await anaClient.changes("billing-prod");
    assert.equal(logged.text, `Logged change ${c!.id} (active)`);
    assert.equal(c!.status, "active");
    assert.equal(c!.agent?.name, "ben-agent");
    assert.equal((await ben.call("teamkit_update_change", { changeId: c!.id, status: "done" })).text, `Change ${c!.id} is done`);
    assert.equal((await anaClient.changes("billing-prod"))[0]!.status, "done");
  });
});

test("an agent's alert is always suspected", async () => {
  await withAgents(async ({ ben, anaClient }) => {
    const r = await ben.call("teamkit_alert", { room: "billing-prod", text: "Invoice counts differ by 12 between billing and billing-v2" });
    const [a] = await anaClient.alerts("billing-prod");
    assert.equal(r.text, `Alert ${a!.id} raised as suspected`);
    assert.equal(a!.level, "suspected");
    assert.equal(a!.raisedBy.name, "ben-agent");
  });
});
