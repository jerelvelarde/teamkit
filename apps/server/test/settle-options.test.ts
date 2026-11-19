import type { EventKind } from "@copilotkit/teamkit-protocol";
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { assertAguiValid } from "./helpers/agui.js";
import { createTask } from "../src/store/tasks.js";
import { claimTask, clearPendingResume, complete, fail, release } from "../src/store/claims.js";
import { answer, block } from "../src/store/blocks.js";
import { listEvents } from "../src/store/events.js";
import { loadTask } from "../src/store/task-load.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

async function lastAgui(db: Parameters<typeof listEvents>[0], kind: EventKind): Promise<{ type: string; name?: string }[]> {
  const { events } = await listEvents(db, { kinds: [kind] });
  const agui = events[events.length - 1]!.agui as { type: string; name?: string }[];
  assertAguiValid(agui);
  return agui;
}

test("complete, fail and release with closesRun false write CUSTOM, not run endings", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const cases = [
      ["task.completed", "teamkit.task.completed", (t: string, c: string) => complete(db, bot, t, c, "ok", { closesRun: false })],
      ["task.failed", "teamkit.task.failed", (t: string, c: string) => fail(db, bot, t, c, "bad", { closesRun: false })],
      ["task.released", "teamkit.task.released", (t: string, c: string) => release(db, bot, t, c, { closesRun: false })],
    ] as const;
    for (const [kind, name, settle] of cases) {
      const t = await createTask(db, bot, { room: "build", brief: kind });
      const claim = await claimTask(db, bot, t.id, { opensRun: false });
      await settle(t.id, claim.claimId);
      const agui = await lastAgui(db, kind);
      assert.equal(agui.length, 1);
      assert.equal(agui[0]!.type, "CUSTOM");
      assert.equal(agui[0]!.name, name);
      assert.ok(!agui.some((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR"));
    }
  });
});

test("defaults still close the run", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const t = await createTask(db, bot, { room: "build", brief: "x" });
    const claim = await claimTask(db, bot, t.id);
    await complete(db, bot, t.id, claim.claimId, "ok");
    assert.equal((await lastAgui(db, "task.completed"))[0]!.type, "RUN_FINISHED");
  });
});

test("release with countAttempt twice gives attempts 2; without it nothing is counted", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const t = await createTask(db, bot, { room: "build", brief: "x" });
    let claim = await claimTask(db, bot, t.id);
    await release(db, bot, t.id, claim.claimId);
    assert.equal((await loadTask(db, t.id))!.attempts, 0);
    for (let i = 0; i < 2; i++) {
      claim = await claimTask(db, bot, t.id);
      await release(db, bot, t.id, claim.claimId, { countAttempt: true });
    }
    assert.equal((await loadTask(db, t.id))!.attempts, 2);
  });
});

test("block with a caller interrupt id keeps it through the answer", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const ann = await personAuth(db, "ann", "member");
    const t = await createTask(db, bot, { room: "build", brief: "x" });
    const claim = await claimTask(db, bot, t.id, { opensRun: false });
    const blocked = await block(
      db, bot, t.id, claim.claimId,
      { question: "ship it?", kind: "needs_input", options: ["approve", "reject"], interruptId: "agent-int-1" },
      { closesRun: false },
    );
    assert.equal(blocked.block!.interruptId, "agent-int-1");
    const agui = await lastAgui(db, "task.blocked");
    const ev = agui.find((e) => e.name === "teamkit.task.blocked");
    assert.ok(ev);
    assert.ok(!agui.some((e) => e.type === "RUN_FINISHED"));
    const answered = await answer(db, ann, t.id, { choice: "approve" });
    assert.equal(answered.pendingResume![0]!.interruptId, "agent-int-1");
  });
});

test("block rejects a bad interrupt id", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const t = await createTask(db, bot, { room: "build", brief: "x" });
    const claim = await claimTask(db, bot, t.id);
    for (const interruptId of ["", "x".repeat(201), "a\u0000b"]) {
      await assert.rejects(
        block(db, bot, t.id, claim.claimId, { question: "q", kind: "needs_input", interruptId }),
        code("invalid_input"),
      );
    }
  });
});

test("clearPendingResume clears it, and a stale claim is claim_lost", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const ann = await personAuth(db, "ann", "member");
    const t = await createTask(db, bot, { room: "build", brief: "x" });
    const first = await claimTask(db, bot, t.id);
    await block(db, bot, t.id, first.claimId, { question: "q", kind: "needs_input" });
    await answer(db, ann, t.id, { text: "yes" });
    assert.ok((await loadTask(db, t.id))!.pendingResume);
    const second = await claimTask(db, bot, t.id);
    await assert.rejects(clearPendingResume(db, bot, t.id, first.claimId), code("claim_lost"));
    const before = (await listEvents(db, {})).events.length;
    await clearPendingResume(db, bot, t.id, second.claimId);
    assert.equal((await loadTask(db, t.id))!.pendingResume, null);
    assert.equal((await listEvents(db, {})).events.length, before);
  });
});
