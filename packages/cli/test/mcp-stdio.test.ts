import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { BIN, isolatedEnv, runNode } from "./helpers/cli.js";
import { mcpTeam } from "./helpers/mcp.js";
import { writeConfigFile } from "../src/config.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("teamkit mcp serves the tools over stdio and reports presence", async () => {
  const { srv, benToken, benClient } = await mcpTeam();
  try {
    const env = isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: benToken, TEAMKIT_ROOMS: "billing-migration" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "mcp"],
      env: env as Record<string, string>,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 17);

    const until = Date.now() + 5000;
    let seen = false;
    while (!seen && Date.now() < until) {
      const p = await benClient.presence("billing-migration");
      seen = p.some((x) => x.actor.name === "ben-agent" && x.sessions.some((s) => JSON.stringify(s.watching) === '["billing-migration"]'));
      if (!seen) await delay(100);
    }
    assert.ok(seen, "ben-agent's presence in billing-migration");

    const pid = transport.pid!;
    await client.close();
    const gone = Date.now() + 3000;
    while (alive(pid) && Date.now() < gone) await delay(50);
    assert.equal(alive(pid), false, "the server exits on its own once stdin closes");
    assert.ok(!stderr.includes(benToken));
  } finally {
    await srv.stop();
  }
});

test("teamkit mcp --app codex acts with the codex token saved on this machine", async () => {
  const { srv, anaToken, benToken, benClient } = await mcpTeam();
  try {
    const env = isolatedEnv({ TEAMKIT_ROOMS: "billing-migration" });
    writeConfigFile({ url: srv.url, token: anaToken, apps: { codex: benToken } }, env);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "mcp", "--app", "codex"],
      env: env as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    const until = Date.now() + 5000;
    let names: string[] = [];
    while (!names.includes("ben-agent") && Date.now() < until) {
      names = (await benClient.presence("billing-migration")).map((p) => p.actor.name);
      if (!names.includes("ben-agent")) await delay(100);
    }
    assert.deepEqual(names, ["ben-agent"], "only the codex token's agent is on");
    await client.close();
  } finally {
    await srv.stop();
  }
});

test("teamkit mcp with an unknown --app exits 2 before serving", async () => {
  const r = await runNode([BIN, "mcp", "--app", "cursor"], isolatedEnv(), { input: "" });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /--app must be one of claude, codex/);
});
