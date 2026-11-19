import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { EventSchemas } from "@ag-ui/core/schemas";
import { createClient, TeamkitError } from "@copilotkit/teamkit-client";
import type { BoardEvent, Task } from "@copilotkit/teamkit-protocol";
import { createExampleApp } from "../examples/service-agent/src/app.js";
import { startDispatcher } from "../apps/server/src/dispatch/dispatcher.js";
import { registerAgent } from "../apps/server/src/dispatch/registry.js";
import { createNotifier } from "../apps/server/src/notifier.js";
import { consumeSignInLink, invitePerson } from "../apps/server/src/store/people.js";
import { setRoom } from "../apps/server/src/store/rooms.js";
import { serveApp } from "../apps/server/test/helpers/notifier.js";
import { agentToken, startTestServer } from "../apps/server/test/helpers/server.js";

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

test("a service agent asks for approval, a person approves, and the task completes", { timeout: 60_000 }, async () => {
  const srv = await startTestServer();
  const notifier = await createNotifier(srv.db);
  const example = await serveApp(createExampleApp({}));
  let dispatcher: ReturnType<typeof startDispatcher> | undefined;
  try {
    await registerAgent(srv.db, { name: "approver", url: `${example.url}/approver`, rooms: ["ship"] });
    await setRoom(srv.db, "ship", { agent: "approver", approvers: ["ada"] });
    const invite = await invitePerson(srv.db, { name: "ada", role: "admin" });
    const { sessionSecret } = await consumeSignInLink(srv.db, invite.secret);

    dispatcher = startDispatcher({ db: srv.db, notifier, pollMs: 200, log: () => {} });

    const worker = await agentToken(srv.db, "worker", [{ room: "ship", perms: ["read", "post", "create"] }]);
    const client = createClient({ url: srv.url, token: worker });
    const created = await client.createTask({ room: "ship", brief: "Ship v1.2" });
    const id = created.id;

    const blocked = await until<Task>("the task to block", async () => {
      const t = (await client.thread(id)).task;
      return t?.state === "blocked" ? t : undefined;
    });
    assert.equal(blocked.block?.kind, "awaiting_approval");
    assert.deepEqual(blocked.block?.options, ["approve", "reject"]);
    assert.match(blocked.block?.interruptId ?? "", /^approve_run_/);

    await assert.rejects(
      client.answer(id, { choice: "approve" }),
      (e: unknown) => e instanceof TeamkitError && e.code === "approval_requires_person",
    );

    const res = await fetch(`${srv.url}/v1/tasks/${id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `teamkit_session=${sessionSecret}` },
      body: JSON.stringify({ choice: "approve" }),
    });
    assert.equal(res.status, 200, await res.text());

    const done = await until<Task>("the task to complete", async () => {
      const t = (await client.thread(id)).task;
      return t?.state === "completed" ? t : undefined;
    });
    assert.equal(done.result, "shipped");

    const view = await client.thread(id);
    const texts = JSON.stringify(view.messages);
    assert.ok(texts.includes("Shipped."), "thread has no Shipped. message");

    const all: BoardEvent[] = [];
    for (let after = "0"; ; ) {
      const page = await client.events({ room: "ship", after, limit: 100 });
      if (page.events.length === 0) break;
      all.push(...page.events);
      after = page.events[page.events.length - 1]!.cursor;
    }

    const started = all.filter((e) => e.kind === "run.event" && e.agui[0]?.type === "RUN_STARTED");
    assert.ok(started.length >= 2, "expected a RUN_STARTED for the first run and for the resume");
    for (const e of started) {
      const meta = (e.agui[0] as { metadata?: { teamkit?: { claimId?: unknown } } }).metadata;
      assert.equal(typeof meta?.teamkit?.claimId, "string", "RUN_STARTED lacks metadata.teamkit.claimId");
    }

    let open = 0;
    let aguiCount = 0;
    for (const e of all.filter((x) => x.threadId === id)) {
      for (const a of e.agui) {
        EventSchemas.parse(a);
        aguiCount++;
        if (a.type === "RUN_STARTED") {
          assert.equal(open, 0, "RUN_STARTED inside an open run");
          open++;
        } else if (a.type === "RUN_FINISHED" || a.type === "RUN_ERROR") {
          assert.equal(open, 1, `${a.type} with no open run`);
          open--;
        }
      }
    }
    assert.equal(open, 0, "a run was left open");
    for (const e of all) for (const a of e.agui) EventSchemas.parse(a);
    assert.ok(aguiCount > 0);
  } finally {
    await dispatcher?.stop();
    await notifier.close();
    await example.close();
    await srv.stop();
  }
});
