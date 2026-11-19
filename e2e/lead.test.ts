import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { EventSchemas } from "@ag-ui/core/schemas";
import { createClient } from "@copilotkit/teamkit-client";
import type { BoardEvent } from "@copilotkit/teamkit-protocol";
import { createExampleApp } from "../examples/service-agent/src/app.js";
import { agentAuthContext, registerAgent } from "../apps/server/src/dispatch/registry.js";
import { createNotifier } from "../apps/server/src/notifier.js";
import { listEvents } from "../apps/server/src/store/events.js";
import { loadTask } from "../apps/server/src/store/task-load.js";
import { getThread } from "../apps/server/src/store/threads.js";
import { findLeadThread } from "../apps/server/src/triggers/lead.js";
import { addTrigger, listTriggers } from "../apps/server/src/triggers/store.js";
import { startTriggers } from "../apps/server/src/triggers/runner.js";
import { serveApp } from "../apps/server/test/helpers/notifier.js";
import { agentToken, startTestServer } from "../apps/server/test/helpers/server.js";

async function until<T>(what: string, ms: number, probe: () => Promise<T | null | false>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

test("a trigger wakes the lead, which answers a blocked task; an approval is left for a person", { timeout: 60_000 }, async () => {
  const srv = await startTestServer();
  const notifier = await createNotifier(srv.db);
  const ex = await serveApp(createExampleApp({}));
  let runner: ReturnType<typeof startTriggers> | undefined;
  try {
    const lead = await registerAgent(srv.db, { name: "lead", url: `${ex.url}/lead`, rooms: ["build"] });
    const { trigger } = await addTrigger(srv.db, { name: "lead-wake", room: "build/", kinds: ["task.blocked"], agent: "lead" });
    runner = startTriggers({ db: srv.db, notifier, pollMs: 200 });

    const token = await agentToken(srv.db, "worker", [{ room: "build", perms: ["read", "post", "claim", "create"] }]);
    const worker = createClient({ url: srv.url, token });

    const leadThread = () => findLeadThread(srv.db, lead, "build");
    const bodies = async (): Promise<string[]> => {
      const id = await leadThread();
      if (!id) return [];
      const { messages } = await getThread(srv.db, agentAuthContext(lead), id);
      return messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    };

    // Flow 1: needs_input with options is answered by the lead; the worker re-claims and completes.
    const t1 = await worker.createTask({ room: "build", brief: "Pick a database and use it" });
    const c1 = await worker.claim(t1.id);
    await worker.block(t1.id, c1.claimId, { question: "Which database?", kind: "needs_input", options: ["pg", "sqlite"] });

    const answered = await until("the task to be answered", 10_000, async () => {
      const t = await loadTask(srv.db, t1.id);
      return t?.state === "ready" && t.pendingResume?.[0]?.payload?.choice === "pg" ? t : null;
    });
    assert.equal(answered.pendingResume?.[0]?.payload?.choice, "pg");
    await until("the lead's reply", 10_000, async () => (await bodies()).includes(`Answered ${t1.id}.`) || null);
    const wake = `Task ${t1.id} in build is now blocked: Pick a database and use it. Read it with teamkit_read.`;
    assert.ok((await bodies()).includes(wake), "wake-up text is on the lead thread");

    const c2 = await worker.claim(t1.id);
    const done = await worker.complete(t1.id, c2.claimId, "Used pg.");
    assert.equal(done.state, "completed");

    // Flow 2: an approval stays blocked; the lead says a person must approve.
    const t2 = await worker.createTask({ room: "build", brief: "Ship it" });
    const c3 = await worker.claim(t2.id);
    await worker.block(t2.id, c3.claimId, { question: "Ship to production?", kind: "awaiting_approval" });
    await until("the lead's note on approvals", 10_000, async () =>
      (await bodies()).some((b) => b.includes("Approvals need a person")) || null,
    );
    await sleep(1000);
    assert.equal((await loadTask(srv.db, t2.id))?.state, "blocked", "approval is still blocked");

    await runner.idle();
    const threadId = (await leadThread())!;
    assert.ok(threadId);

    // The lead thread holds no task events.
    const leadEvents = (await listEvents(srv.db, { threadId })).events;
    assert.ok(leadEvents.length > 0);
    assert.equal(leadEvents.some((e) => e.kind.startsWith("task.")), false, "no task.* event on the lead thread");

    // The trigger cursor moved past both blocked events.
    const blockedEvents = (await listEvents(srv.db, { room: "build", kinds: ["task.blocked"] })).events;
    assert.equal(blockedEvents.length, 2);
    const stored = (await listTriggers(srv.db)).find((t) => t.id === trigger.id)!;
    assert.ok(BigInt(stored.cursor) >= BigInt(blockedEvents[1]!.cursor), "trigger cursor advanced");
    assert.ok(BigInt(stored.cursor) > BigInt(trigger.cursor));

    // Everything logged is valid AG-UI.
    const all: BoardEvent[] = [];
    for (let after = "0"; ; ) {
      const page = await worker.events({ room: "build", after, limit: 100 });
      if (page.events.length === 0) break;
      all.push(...page.events);
      after = page.events[page.events.length - 1]!.cursor;
    }
    let count = 0;
    for (const e of [...all, ...leadEvents]) {
      for (const a of e.agui) {
        EventSchemas.parse(a);
        count++;
      }
    }
    assert.ok(count > 0);
  } finally {
    await runner?.stop();
    await ex.close();
    await notifier.close();
    await srv.stop();
  }
});
