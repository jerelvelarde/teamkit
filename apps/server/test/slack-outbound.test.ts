import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Db } from "../src/db/pool.js";
import { createNotifier, type Notifier } from "../src/notifier.js";
import { getServiceCursor, getSlackThread } from "../src/slack/mirror.js";
import { processOutboundOnce, startOutbound } from "../src/slack/outbound.js";
import { block } from "../src/store/blocks.js";
import { claimTask, complete } from "../src/store/claims.js";
import { setRoom } from "../src/store/rooms.js";
import { createTask } from "../src/store/tasks.js";
import { agentAuth as makeAgent } from "./helpers/actors.js";
import { withTestDb } from "./helpers/db.js";

const TOKEN = "fake-bot-token-for-tests";

interface Recorded {
  auth: string | undefined;
  contentType: string | undefined;
  body: any;
}

async function fakeSlack(failFirst = 0) {
  const requests: Recorded[] = [];
  let n = 0;
  let failures = failFirst;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: JSON.parse(raw),
      });
      res.setHeader("content-type", "application/json");
      if (failures > 0) {
        failures--;
        res.end(JSON.stringify({ ok: false, error: "ratelimited" }));
        return;
      }
      n++;
      res.end(JSON.stringify({ ok: true, ts: `${n}.000` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    requests,
    apiBase,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const bots = new WeakMap<Db, ReturnType<typeof makeAgent>>();
/** One "bot" agent per database; agentAuth creates a new actor on every call. */
const agentAuth = (db: Db, _name: string) => {
  let bot = bots.get(db);
  if (!bot) bots.set(db, (bot = makeAgent(db, "bot")));
  return bot;
};

const idleNotifier: Notifier = { onEvent: () => () => {}, close: async () => {} };

const opts = (db: Db, apiBase: string, notifier: Notifier = idleNotifier) => ({
  db,
  notifier,
  slack: { token: TOKEN, apiBase },
  publicUrl: "http://board.test",
  log: () => {},
});

async function blockTask(db: Db, room = "build") {
  const bot = await agentAuth(db, "bot");
  const t = await createTask(db, bot, { room, brief: "ship it" });
  const claim = await claimTask(db, bot, t.id);
  await block(db, bot, t.id, claim.claimId, {
    question: "Deploy?",
    kind: "awaiting_approval",
    options: ["approve", "reject"],
  });
  return { bot, t };
}

const hasAnswerButton = (body: any) => JSON.stringify(body.blocks).includes('"action_id":"teamkit.answer"');

test("a blocked task posts top-level, then its outcome posts into that thread", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      await setRoom(db, "build", { slackChannel: "C1" });
      assert.equal(await processOutboundOnce(opts(db, slack.apiBase)), 0);
      const { bot, t } = await blockTask(db);
      assert.equal(await processOutboundOnce(opts(db, slack.apiBase)), 1);
      const first = slack.requests[0]!;
      assert.equal(first.body.channel, "C1");
      assert.equal(first.body.thread_ts, undefined);
      assert.ok(hasAnswerButton(first.body));
      assert.ok(typeof first.body.text === "string" && first.body.text.length > 0);
      const mirror = await getSlackThread(db, t.id);
      assert.deepEqual([mirror?.channel, mirror?.ts, mirror?.conversationKey], ["C1", "1.000", "C1::1.000"]);

      // Put the task back to ready (as an answer would), claim it again and complete it.
      await db`update tasks set state = 'ready', block = null where thread_id = ${t.id}`;
      const c2 = await claimTask(db, bot, t.id);
      await complete(db, bot, t.id, c2.claimId, "done <!channel>");
      assert.equal(await processOutboundOnce(opts(db, slack.apiBase)), 1);
      const second = slack.requests[1]!;
      assert.equal(second.body.thread_ts, "1.000");
      assert.equal(second.body.channel, "C1");
      assert.match(JSON.stringify(second.body.blocks), /done &lt;!channel&gt;/);
    });
  } finally {
    await slack.close();
  }
});

test("requests carry the bearer and a JSON content type, and the body never holds the token", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      await setRoom(db, "build", { slackChannel: "C1" });
      await processOutboundOnce(opts(db, slack.apiBase));
      await blockTask(db);
      await processOutboundOnce(opts(db, slack.apiBase));
      assert.equal(slack.requests.length, 1);
      assert.equal(slack.requests[0]!.auth, `Bearer ${TOKEN}`);
      assert.equal(slack.requests[0]!.contentType, "application/json; charset=utf-8");
      assert.ok(!JSON.stringify(slack.requests[0]!.body).includes(TOKEN));
    });
  } finally {
    await slack.close();
  }
});

test("completing a never-blocked task posts nothing unless announce is all", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      await setRoom(db, "build", { slackChannel: "C1" });
      await processOutboundOnce(opts(db, slack.apiBase));
      const bot = await agentAuth(db, "bot");
      const t = await createTask(db, bot, { room: "build", brief: "quiet" });
      const c = await claimTask(db, bot, t.id);
      await complete(db, bot, t.id, c.claimId, "ok");
      assert.equal(await processOutboundOnce(opts(db, slack.apiBase)), 0);
      assert.equal(slack.requests.length, 0);

      await setRoom(db, "build", { slackAnnounce: "all" });
      const t2 = await createTask(db, bot, { room: "build", brief: "loud" });
      const c2 = await claimTask(db, bot, t2.id);
      await complete(db, bot, t2.id, c2.claimId, "fine");
      assert.equal(await processOutboundOnce(opts(db, slack.apiBase)), 1);
      assert.equal(slack.requests[0]!.body.thread_ts, undefined);
      assert.equal((await getSlackThread(db, t2.id))?.ts, "1.000");
    });
  } finally {
    await slack.close();
  }
});

test("announce none posts nothing, and rooms without a channel are skipped", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      await setRoom(db, "build", { slackChannel: "C1", slackAnnounce: "none" });
      await setRoom(db, "ops", {});
      await processOutboundOnce(opts(db, slack.apiBase));
      await blockTask(db);
      await blockTask(db, "ops");
      assert.equal(await processOutboundOnce(opts(db, slack.apiBase)), 0);
      assert.equal(slack.requests.length, 0);
    });
  } finally {
    await slack.close();
  }
});

test("the cursor persists: a fresh pass repeats nothing, a new event posts once", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      await setRoom(db, "build", { slackChannel: "C1" });
      await processOutboundOnce(opts(db, slack.apiBase));
      await blockTask(db);
      assert.equal(await processOutboundOnce(opts(db, slack.apiBase)), 1);
      const cursor = await getServiceCursor(db, "slack-outbound");
      assert.equal(await processOutboundOnce(opts(db, slack.apiBase)), 0);
      assert.equal(await getServiceCursor(db, "slack-outbound"), cursor);
      assert.equal(slack.requests.length, 1);
      const bot = await agentAuth(db, "bot");
      const t = await createTask(db, bot, { room: "build", brief: "again" });
      const c = await claimTask(db, bot, t.id);
      await block(db, bot, t.id, c.claimId, { question: "more?", kind: "needs_input" });
      assert.equal(await processOutboundOnce(opts(db, slack.apiBase)), 1);
      assert.equal(slack.requests.length, 2);
      assert.ok(!hasAnswerButton(slack.requests[1]!.body));
    });
  } finally {
    await slack.close();
  }
});

test("history before the first run is never replayed", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      await setRoom(db, "build", { slackChannel: "C1" });
      await blockTask(db);
      assert.equal(await processOutboundOnce(opts(db, slack.apiBase)), 0);
      assert.equal(slack.requests.length, 0);
    });
  } finally {
    await slack.close();
  }
});

test("ratelimited twice then ok: one post lands and the cursor advances", async () => {
  const slack = await fakeSlack(2);
  try {
    await withTestDb(async (db) => {
      await setRoom(db, "build", { slackChannel: "C1" });
      await processOutboundOnce(opts(db, slack.apiBase));
      const before = await getServiceCursor(db, "slack-outbound");
      await blockTask(db);
      assert.equal(await processOutboundOnce(opts(db, slack.apiBase)), 1);
      assert.equal(slack.requests.length, 3);
      assert.notEqual(await getServiceCursor(db, "slack-outbound"), before);
      assert.equal(await processOutboundOnce(opts(db, slack.apiBase)), 0);
    });
  } finally {
    await slack.close();
  }
});

test("after three failures the event is logged and skipped, without the token", async () => {
  const slack = await fakeSlack(99);
  const lines: string[] = [];
  try {
    await withTestDb(async (db) => {
      await setRoom(db, "build", { slackChannel: "C1" });
      const o = { ...opts(db, slack.apiBase), log: (l: string) => lines.push(l) };
      await processOutboundOnce(o);
      await blockTask(db);
      assert.equal(await processOutboundOnce(o), 0);
      assert.equal(slack.requests.length, 3);
      assert.equal(await processOutboundOnce(o), 0);
      assert.equal(slack.requests.length, 3);
      assert.equal(lines.length, 1);
      assert.ok(!lines.join("\n").includes(TOKEN));
      assert.match(lines[0]!, /ratelimited/);
    });
  } finally {
    await slack.close();
  }
});

test("startOutbound posts on a notification and stop() ends it", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      await setRoom(db, "build", { slackChannel: "C1" });
      const notifier = await createNotifier(db);
      const handle = await startOutbound({ ...opts(db, slack.apiBase, notifier), pollMs: 60_000 });
      for (let i = 0; i < 100 && (await getServiceCursor(db, "slack-outbound")) === null; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await blockTask(db);
      for (let i = 0; i < 200 && slack.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(slack.requests.length, 1);
      await handle.stop();
      await notifier.close();
    });
  } finally {
    await slack.close();
  }
});
