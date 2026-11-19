import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { BIN, isolatedEnv } from "./helpers/cli.js";
import { mcpTeam } from "./helpers/mcp.js";

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
