import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { EventSchemas } from "@ag-ui/core/schemas";
import { createClient } from "@copilotkit/teamkit-client";
import type { BoardEvent } from "@copilotkit/teamkit-protocol";
import { agentToken, startTestServer } from "../apps/server/test/helpers/server.js";
import { isolatedEnv, runCli } from "../packages/cli/test/helpers/cli.js";

const AGENT_E2E = fileURLToPath(new URL("../packages/cli/test/fixtures/agent-e2e.mjs", import.meta.url));
const DEADLINE_MS = 90_000;

test("a lead, two workers and a reviewer finish a plan, including a blocked question", { timeout: 120_000 }, async () => {
  const srv = await startTestServer();
  try {
    const lead = await agentToken(srv.db, "lead", [{ room: "build", perms: ["read", "post", "create"] }]);
    const member = { room: "build", perms: ["read", "post", "claim"] as ("read" | "post" | "claim")[] };
    const w1 = await agentToken(srv.db, "worker-1", [member]);
    const w2 = await agentToken(srv.db, "worker-2", [member]);
    const r1 = await agentToken(srv.db, "reviewer-1", [member]);

    const client = createClient({ url: srv.url, token: lead });
    const leadEnv = isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: lead });
    const tasks = await client.createPlan("build", [
      { key: "limiter", text: "Build the limiter", labels: { role: "worker" } },
      { key: "ask", text: "[ask] Pick a database and use it", labels: { role: "worker" } },
      { key: "review", text: "Review the limiter", labels: { role: "reviewer" }, needs: [{ key: "limiter" }] },
    ]);
    const limiter = tasks.limiter!.id;
    const ask = tasks.ask!.id;
    const review = tasks.review!.id;
    const ids = [limiter, ask, review];

    let done = false;
    const unexpected: string[] = [];
    const loop = async (token: string, role: string): Promise<void> => {
      const env = isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: token });
      const deadline = Date.now() + DEADLINE_MS;
      while (!done && Date.now() < deadline) {
        const r = await runCli(
          ["run", "--ready", "build", "--label", `role=${role}`, "--wait", "5s", "--", "node", AGENT_E2E],
          env,
          { timeoutMs: 60_000 },
        );
        if (r.code !== 0 && r.code !== 3) unexpected.push(`${role}: exit ${r.code}\n${r.stderr}`);
      }
    };
    const loops = [loop(w1, "worker"), loop(w2, "worker"), loop(r1, "reviewer")];

    const states = async () => Promise.all(ids.map(async (id) => (await client.thread(id)).task?.state));
    const deadline = Date.now() + DEADLINE_MS;
    let answered = false;
    try {
      while (Date.now() < deadline) {
        const s = await states();
        if (!answered && s[1] === "blocked") {
          const r = await runCli(["tasks", "answer", ask, "Use pg.", "--choice", "pg"], leadEnv);
          assert.equal(r.code, 0, r.stderr);
          answered = true;
        }
        if (s.every((x) => x === "completed")) break;
        await sleep(100);
      }
    } finally {
      done = true;
      await Promise.all(loops);
    }

    assert.deepEqual(unexpected, []);
    assert.deepEqual(await states(), ["completed", "completed", "completed"]);

    const all: BoardEvent[] = [];
    for (let after = "0"; ; ) {
      const page = await client.events({ room: "build", after, limit: 100 });
      if (page.events.length === 0) break;
      all.push(...page.events);
      after = page.events[page.events.length - 1]!.cursor;
    }
    const cursorOf = (kind: string, thread: string, which: "first" | "last" = "first"): bigint => {
      const hits = all.filter((e) => e.kind === kind && e.threadId === thread);
      assert.ok(hits.length > 0, `no ${kind} event for ${thread}`);
      return BigInt(hits[which === "first" ? 0 : hits.length - 1]!.cursor);
    };

    assert.ok(cursorOf("task.claimed", review) > cursorOf("task.completed", limiter), "review claimed before limiter completed");
    const blocked = cursorOf("task.blocked", ask);
    const answeredAt = cursorOf("task.answered", ask);
    const completed = cursorOf("task.completed", ask);
    assert.ok(blocked < answeredAt && answeredAt < completed, "ask events out of order");

    let aguiCount = 0;
    for (const e of all) {
      for (const a of e.agui) {
        EventSchemas.parse(a);
        aguiCount++;
      }
    }
    assert.ok(aguiCount > 0, "no agui events in the log");
  } finally {
    await srv.stop();
  }
});
