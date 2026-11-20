import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { PRESENCE_ON_MS } from "@copilotkit/teamkit-protocol";
import type { Db } from "../src/db/pool.js";
import { createNotifier } from "../src/notifier.js";
import { getStatusMessage } from "../src/slack/mirror.js";
import {
  newStatusMemory,
  processStatusOnce,
  roomStatus,
  startSlackStatus,
  STATUS_FAILED_RETRY_MS,
  STATUS_MIN_EDIT_GAP_MS,
  type StatusMemory,
  type StatusOptions,
} from "../src/slack/status.js";
import { block } from "../src/store/blocks.js";
import { claimTask } from "../src/store/claims.js";
import { setRoom } from "../src/store/rooms.js";
import { createTask } from "../src/store/tasks.js";
import { api, CHANNEL, seedBilling, type Billing } from "./helpers/billing.js";
import { withTestDb } from "./helpers/db.js";
import { fakeSlack, idleNotifier, type SlackRequest } from "./helpers/fake-slack.js";
import { startTestServer } from "./helpers/server.js";

const T0 = Date.now();
const opts = (db: Db, apiBase: string, now: number, extra: Partial<StatusOptions> = {}): StatusOptions =>
  ({ db, notifier: idleNotifier, slack: { token: "fake-bot-token", apiBase }, publicUrl: "http://board.test", now: () => now, log: () => {}, ...extra });
const updates = (rs: SlackRequest[]) => rs.filter((r) => r.method === "chat.update");
const ASK = { question: "Approve the cutover write to billing-prod?", kind: "awaiting_approval" as const, options: ["approve", "reject"] };
const COPY = "Copy the invoices table to the new database";

/** The billing seed with billing-prod taken off Slack, so only billing-migration has a status. */
async function migrationOnly(db: Db): Promise<Billing> {
  const b = await seedBilling(db);
  await setRoom(db, "billing-prod", { slackChannel: null });
  return b;
}

test("the first pass posts and pins one status message per linked room", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      await seedBilling(db);
      const r = await processStatusOnce(opts(db, slack.apiBase, T0));
      assert.deepEqual(slack.requests.map((q) => [q.method, q.body.channel, q.body.timestamp]), [
        ["chat.postMessage", CHANNEL.migration, undefined],
        ["pins.add", CHANNEL.migration, "1.000"],
        ["chat.postMessage", CHANNEL.prod, undefined],
        ["pins.add", CHANNEL.prod, "2.000"],
      ]);
      assert.deepEqual(r, { posted: 2, edited: 0, retry: null });
      const row = await getStatusMessage(db, "billing-migration");
      assert.deepEqual([row?.ts, row?.pinned, row?.editedAt], ["1.000", true, T0]);
    });
  } finally {
    await slack.close();
  }
});

test("an unchanged status is never sent again; a change edits the same message", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      const b = await migrationOnly(db);
      await processStatusOnce(opts(db, slack.apiBase, T0));
      const n = slack.requests.length;
      await processStatusOnce(opts(db, slack.apiBase, T0 + 20_000));
      assert.equal(slack.requests.length, n);
      await createTask(db, b.benAgent, { room: "billing-migration", brief: COPY });
      await processStatusOnce(opts(db, slack.apiBase, T0 + 40_000));
      const sent = slack.requests.slice(n);
      assert.equal(sent.length, 1);
      assert.deepEqual([sent[0]!.method, sent[0]!.body.channel, sent[0]!.body.ts], ["chat.update", CHANNEL.migration, "1.000"]);
      assert.match(JSON.stringify(sent[0]!.body.blocks), /1 ready/);
    });
  } finally {
    await slack.close();
  }
});

test("edits are at most one per 10 s per room, and the last state wins", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      const b = await migrationOnly(db);
      await processStatusOnce(opts(db, slack.apiBase, T0));
      const t = await createTask(db, b.benAgent, { room: "billing-migration", brief: COPY });
      await processStatusOnce(opts(db, slack.apiBase, T0 + 1_000));
      assert.equal(updates(slack.requests).length, 0);
      const c = await claimTask(db, b.benAgent, t.id);
      await processStatusOnce(opts(db, slack.apiBase, T0 + 5_000));
      assert.equal(updates(slack.requests).length, 0);
      await processStatusOnce(opts(db, slack.apiBase, T0 + 10_000));
      assert.equal(updates(slack.requests).length, 1);
      assert.ok(JSON.stringify(updates(slack.requests)[0]!.body.blocks).includes(`• ben-agent: <http://board.test/t/${t.id}|${COPY}>`));
      await block(db, b.benAgent, t.id, c.claimId, ASK);
      await processStatusOnce(opts(db, slack.apiBase, T0 + 11_000));
      assert.equal(updates(slack.requests).length, 1);
      await processStatusOnce(opts(db, slack.apiBase, T0 + 20_000));
      assert.equal(updates(slack.requests).length, 2);
      assert.match(JSON.stringify(updates(slack.requests)[1]!.body.blocks), /Approve the cutover write to billing-prod\?/);
    });
  } finally {
    await slack.close();
  }
});

test("roomStatus shows agents on, work, and asks with who they wait on", async () => {
  const s = await startTestServer();
  try {
    const b = await seedBilling(s.db);
    await api(s.url, b.benAgent.token, "/v1/presence", { watching: ["billing-prod"] });
    const a = await createTask(s.db, b.benAgent, { room: "billing-prod", brief: COPY });
    await claimTask(s.db, b.benAgent, a.id);
    const bt = await createTask(s.db, b.benAgent, { room: "billing-prod", brief: "Enable writes on the new invoices table" });
    const bc = await claimTask(s.db, b.benAgent, bt.id);
    await block(s.db, b.benAgent, bt.id, bc.claimId, { ...ASK, approvers: ["sam"] });
    await createTask(s.db, b.benAgent, { room: "billing-prod", brief: "Rebuild the invoice indexes" });
    assert.deepEqual(await roomStatus(s.db, "billing-prod", "http://board.test", Date.now()), {
      room: "billing-prod",
      roomUrl: "http://board.test/?room=billing-prod",
      agentsOn: [{ name: "ben-agent", sessions: 1 }],
      working: [{ taskId: a.id, brief: COPY, by: "ben-agent", url: `http://board.test/t/${a.id}` }],
      asks: [{ taskId: bt.id, question: ASK.question, waitsOn: ["sam"], url: `http://board.test/t/${bt.id}` }],
      moreWorking: 0,
      moreAsks: 0,
      counts: { ready: 1, waiting: 0, claimed: 1, blocked: 1 },
    });
  } finally {
    await s.stop();
  }
});

test("an agent that stops heartbeating drops off with no board event", async () => {
  const slack = await fakeSlack();
  const s = await startTestServer();
  try {
    const b = await migrationOnly(s.db);
    await api(s.url, b.benAgent.token, "/v1/presence", { watching: ["billing-migration"] });
    const now = Date.now();
    await processStatusOnce(opts(s.db, slack.apiBase, now));
    assert.match(JSON.stringify(slack.requests[0]!.body.blocks), /\*Agents on:\* ben-agent/);
    await processStatusOnce(opts(s.db, slack.apiBase, now + PRESENCE_ON_MS + STATUS_MIN_EDIT_GAP_MS + 1_000));
    const u = updates(slack.requests);
    assert.equal(u.length, 1);
    assert.match(JSON.stringify(u[0]!.body.blocks), /\*Agents on:\* none right now/);
  } finally {
    await s.stop();
    await slack.close();
  }
});

test("a deleted status message is posted again and pinned", async () => {
  const slack = await fakeSlack([{ body: { ok: true, ts: "9.000" } }, { body: { ok: true } }, { body: { ok: false, error: "message_not_found" } }]);
  try {
    await withTestDb(async (db) => {
      const b = await migrationOnly(db);
      await processStatusOnce(opts(db, slack.apiBase, T0));
      await createTask(db, b.benAgent, { room: "billing-migration", brief: COPY });
      await processStatusOnce(opts(db, slack.apiBase, T0 + 10_000));
      assert.deepEqual(slack.requests.slice(2).map((r) => [r.method, r.body.ts, r.body.timestamp]), [
        ["chat.update", "9.000", undefined],
        ["chat.postMessage", undefined, undefined],
        ["pins.add", undefined, "1.000"],
      ]);
      const row = await getStatusMessage(db, "billing-migration");
      assert.deepEqual([row?.ts, row?.pinned], ["1.000", true]);
    });
  } finally {
    await slack.close();
  }
});

test("a pin that Slack rate-limited is added on the next pass, even with nothing new to show", async () => {
  const slack = await fakeSlack([
    { body: { ok: true, ts: "9.000" } },
    { status: 429, headers: { "retry-after": "1" }, body: { ok: false, error: "ratelimited" } },
  ]);
  try {
    await withTestDb(async (db) => {
      await migrationOnly(db);
      const first = await processStatusOnce(opts(db, slack.apiBase, T0));
      assert.equal(first.retry?.afterMs, 1000);
      assert.equal((await getStatusMessage(db, "billing-migration"))?.pinned, false);
      const n = slack.requests.length;
      const second = await processStatusOnce(opts(db, slack.apiBase, T0 + 1_000));
      assert.deepEqual(slack.requests.slice(n).map((r) => [r.method, r.body.timestamp]), [["pins.add", "9.000"]]);
      assert.deepEqual(second, { posted: 0, edited: 0, retry: null });
      assert.equal((await getStatusMessage(db, "billing-migration"))?.pinned, true);
      await processStatusOnce(opts(db, slack.apiBase, T0 + 2_000));
      assert.equal(slack.requests.length, n + 1, "a pinned status is not pinned again");
    });
  } finally {
    await slack.close();
  }
});

test("a pin Slack refuses for good is logged once and tried again only after ten minutes", async () => {
  const slack = await fakeSlack([
    { body: { ok: true, ts: "9.000" } },
    { body: { ok: false, error: "too_many_pins" } },
    { body: { ok: false, error: "too_many_pins" } },
  ]);
  try {
    await withTestDb(async (db) => {
      await migrationOnly(db);
      const memory: StatusMemory = newStatusMemory();
      const lines: string[] = [];
      const log = (l: string) => lines.push(l);
      await processStatusOnce(opts(db, slack.apiBase, T0, { log }), memory);
      const n = slack.requests.length;
      await processStatusOnce(opts(db, slack.apiBase, T0 + 60_000, { log }), memory);
      assert.equal(slack.requests.length, n);
      assert.equal(lines.length, 1);
      await processStatusOnce(opts(db, slack.apiBase, T0 + STATUS_FAILED_RETRY_MS + 1, { log }), memory);
      assert.deepEqual(slack.requests.slice(n).map((r) => r.method), ["pins.add"]);
    });
  } finally {
    await slack.close();
  }
});

test("a room moved to another channel gets a new status there; announce none posts none", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      await seedBilling(db);
      await setRoom(db, "billing-prod", { slackAnnounce: "none" });
      await processStatusOnce(opts(db, slack.apiBase, T0));
      assert.equal(slack.requests[0]!.body.channel, CHANNEL.migration);
      const n = slack.requests.length;
      await setRoom(db, "billing-migration", { slackChannel: "C0BILLNEW" });
      await processStatusOnce(opts(db, slack.apiBase, T0 + 1_000));
      assert.deepEqual(slack.requests.slice(n).map((r) => [r.method, r.body.channel]), [
        ["chat.postMessage", "C0BILLNEW"],
        ["pins.add", "C0BILLNEW"],
      ]);
      assert.ok(slack.requests.every((r) => r.body.channel !== CHANNEL.prod));
    });
  } finally {
    await slack.close();
  }
});

test("a busy room lists ten of each and counts the rest", async () => {
  await withTestDb(async (db) => {
    const b = await seedBilling(db);
    for (let i = 0; i < 12; i++) {
      const t = await createTask(db, b.benAgent, { room: "billing-prod", brief: `Copy invoice batch ${i}` });
      await claimTask(db, b.benAgent, t.id);
    }
    for (let i = 0; i < 40; i++) {
      const t = await createTask(db, b.benAgent, { room: "billing-prod", brief: `Verify invoice batch ${i}` });
      const c = await claimTask(db, b.benAgent, t.id);
      await block(db, b.benAgent, t.id, c.claimId, { ...ASK, approvers: ["sam"] });
    }
    const st = await roomStatus(db, "billing-prod", "http://board.test", Date.now());
    assert.deepEqual([st.working.length, st.moreWorking, st.asks.length, st.moreAsks, st.counts.claimed, st.counts.blocked], [10, 2, 10, 30, 12, 40]);
  });
});

test("a channel it cannot post in is logged once and tried again only after ten minutes", async () => {
  const slack = await fakeSlack([{ body: { ok: false, error: "not_in_channel" } }]);
  try {
    await withTestDb(async (db) => {
      const b = await migrationOnly(db);
      const memory: StatusMemory = newStatusMemory();
      const lines: string[] = [];
      const log = (l: string) => lines.push(l);
      await processStatusOnce(opts(db, slack.apiBase, T0, { log }), memory);
      assert.deepEqual(lines, ["slack-status: cannot post the status for billing-migration in C0BILLMIG: slack error not_in_channel"]);
      await createTask(db, b.benAgent, { room: "billing-migration", brief: COPY });
      const n = slack.requests.length;
      await processStatusOnce(opts(db, slack.apiBase, T0 + 60_000, { log }), memory);
      assert.equal(slack.requests.length, n);
      assert.equal(lines.length, 1);
      await processStatusOnce(opts(db, slack.apiBase, T0 + STATUS_FAILED_RETRY_MS + 1, { log }), memory);
      assert.equal(slack.requests.slice(n)[0]?.method, "chat.postMessage");
    });
  } finally {
    await slack.close();
  }
});

test("startSlackStatus edits on a board event, and stop() ends it", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      const b = await migrationOnly(db);
      const notifier = await createNotifier(db);
      const worker = await startSlackStatus({ ...opts(db, slack.apiBase, 0), now: undefined, notifier, minEditGapMs: 0, tickMs: 60_000 });
      try {
        for (let i = 0; i < 200 && slack.requests.length === 0; i++) await delay(20);
        assert.equal(slack.requests[0]?.method, "chat.postMessage");
        await createTask(db, b.benAgent, { room: "billing-migration", brief: COPY });
        for (let i = 0; i < 200 && updates(slack.requests).length === 0; i++) await delay(20);
        assert.equal(updates(slack.requests).length, 1);
      } finally {
        await worker.stop();
        await notifier.close();
      }
    });
  } finally {
    await slack.close();
  }
});
