import { test } from "node:test";
import assert from "node:assert/strict";
import { writeConfigFile } from "../src/config.js";
import { isolatedEnv } from "./helpers/cli.js";
import { connectMcp, mcpTeam, type McpHandle, type McpTeam } from "./helpers/mcp.js";

/** A billing team with ana-agent and ben-agent each connected to its own MCP server. */
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

/** Creates a task as `who` and claims it through MCP; returns its id. */
async function claimed(who: McpHandle, room: string, brief = "Copy the invoices table to billing-v2"): Promise<string> {
  const id = (await who.call("teamkit_create_task", { room, brief })).text.split("\t")[0]!;
  assert.match((await who.call("teamkit_claim", { taskId: id })).text, /^Claimed th_/);
  return id;
}

test("registers the task tools and sends the instructions", async () => {
  await withAgents(async ({ ana }) => {
    const names = await ana.names();
    for (const n of ["teamkit_pending", "teamkit_read", "teamkit_create_task", "teamkit_claim", "teamkit_reply",
      "teamkit_handoff", "teamkit_ask", "teamkit_complete", "teamkit_fail", "teamkit_release"]) {
      assert.ok(names.includes(n), n);
    }
    assert.match(ana.instructions() ?? "", /teamkit_pending/);
  });
});

test("release gives a claimed task back and forgets the claim", async () => {
  await withAgents(async ({ ana, anaClient }) => {
    const id = await claimed(ana, "billing-migration");
    assert.equal((await ana.call("teamkit_release", { taskId: id })).text, `${id}\tready`);
    assert.equal((await anaClient.thread(id)).task?.state, "ready");
    assert.deepEqual(ana.leases.held(), []);
  });
});

test("pending with nothing waiting says so", async () => {
  await withAgents(async ({ ana }) => {
    assert.deepEqual(await ana.call("teamkit_pending"), { text: "Nothing is waiting on you.", isError: false });
  });
});

test("ana-agent claims, replies and completes without passing a claim id", async () => {
  await withAgents(async ({ ana }) => {
    const created = await ana.call("teamkit_create_task", { room: "billing-migration", brief: "Copy the invoices table to billing-v2" });
    const id = created.text.split("\t")[0]!;
    assert.match((await ana.call("teamkit_claim", { taskId: id })).text, /^Claimed th_/);
    assert.equal((await ana.call("teamkit_reply", { threadId: id, text: "Plan: copy in batches of 10k." })).text, "ok");
    assert.equal((await ana.call("teamkit_complete", { taskId: id, result: "Copied 1.2M invoices; counts match." })).text,
      `${id}\tcompleted`);
    assert.deepEqual(ana.leases.held(), []);
  });
});

test("claim by room with nothing ready is not an error", async () => {
  await withAgents(async ({ ana }) => {
    const r = await ana.call("teamkit_claim", { room: "billing-migration" });
    assert.deepEqual(r, { text: "Nothing ready in billing-migration.", isError: false });
  });
});

test("read needs exactly one of threadId and room", async () => {
  await withAgents(async ({ ana }) => {
    const id = (await ana.call("teamkit_create_task", { room: "billing-migration", brief: "Copy the invoices table to billing-v2" }))
      .text.split("\t")[0]!;
    assert.equal((await ana.call("teamkit_read", {})).isError, true);
    assert.equal((await ana.call("teamkit_read", { threadId: id, room: "billing-migration" })).isError, true);
    assert.match((await ana.call("teamkit_read", { room: "billing-migration" })).text, /^billing-migration/);
    assert.match((await ana.call("teamkit_read", { threadId: id })).text, new RegExp(id));
  });
});

test("complete without a claim says to claim first", async () => {
  await withAgents(async ({ ana }) => {
    const id = (await ana.call("teamkit_create_task", { room: "billing-migration", brief: "Copy the invoices table to billing-v2" }))
      .text.split("\t")[0]!;
    const r = await ana.call("teamkit_complete", { taskId: id, result: "x" });
    assert.equal(r.isError, true);
    assert.match(r.text, /claim it first with teamkit_claim/);
  });
});

test("ben-agent asks sam on billing-prod and lets go of the claim", async () => {
  await withAgents(async ({ ben, benClient }) => {
    const id = await claimed(ben, "billing-prod", "Backfill invoices_v2 from invoices_v1");
    const r = await ben.call("teamkit_ask", { taskId: id, question: "Run the invoice backfill on billing-prod tonight?",
      kind: "awaiting_approval", approvers: ["sam"] });
    assert.match(r.text, new RegExp(`^${id}\\tblocked waiting on sam$`));
    const task = (await benClient.thread(id)).task!;
    assert.equal(task.state, "blocked");
    assert.deepEqual(task.block?.approvers, ["sam"]);
    assert.deepEqual(ben.leases.held(), []);
  });
});

test("a handoff holds the task for ben-agent and shows in his pending", async () => {
  await withAgents(async ({ ana, ben, anaClient }) => {
    const id = await claimed(ana, "billing-migration");
    assert.match((await ana.call("teamkit_handoff", { taskId: id, to: "ben-agent" })).text, /held for ben-agent until /);
    assert.equal((await anaClient.thread(id)).task?.reservedFor?.name, "ben-agent");
    assert.deepEqual(ana.leases.held(), []);
    assert.match((await ben.call("teamkit_pending")).text, new RegExp(id));
  });
});

test("a server error comes back as a tool error with its code", async () => {
  await withAgents(async ({ ana }) => {
    const r = await ana.call("teamkit_claim", { taskId: "th_doesnotexist" });
    assert.equal(r.isError, true);
    assert.match(r.text, /^not_found: /);
  });
});

test("not signed in, then joined mid-session", async () => {
  const t = await mcpTeam();
  const env = isolatedEnv(); // no url, no token
  writeConfigFile({ url: t.srv.url, adminToken: "tk_admin_only" }, env); // admin login only
  const m = await connectMcp(env);
  try {
    const before = await m.call("teamkit_pending");
    assert.equal(before.isError, true);
    assert.match(before.text, /\/teamkit:join/);
    assert.ok(!before.text.includes("tk_admin_only"));
    writeConfigFile({ url: t.srv.url, token: t.anaToken }, env); // what `teamkit join` writes
    assert.equal((await m.call("teamkit_pending")).isError, false);
  } finally {
    await m.close();
    await t.srv.stop();
  }
});
