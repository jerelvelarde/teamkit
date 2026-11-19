import { test } from "node:test";
import assert from "node:assert/strict";
import type { Alert } from "@copilotkit/teamkit-protocol";
import { alertAsPerson, decideAsPerson } from "../src/slack/coordination.js";
import { getSlackPost } from "../src/slack/mirror.js";
import { processOutboundOnce } from "../src/slack/outbound.js";
import { confirmAlert, raiseAlert, resolveAlert } from "../src/store/alerts.js";
import { setRoom } from "../src/store/rooms.js";
import { api, CHANNEL, seedBilling } from "./helpers/billing.js";
import { withTestDb } from "./helpers/db.js";
import { fakeSlack, outboundOptions as out } from "./helpers/fake-slack.js";
import { startTestServer } from "./helpers/server.js";

const GAP = "Invoice totals differ between the old and new database.";

test("a decision posts once at the top level and its acknowledgements edit it in place", async () => {
  const slack = await fakeSlack();
  const s = await startTestServer();
  try {
    const b = await seedBilling(s.db);
    await processOutboundOnce(out(s.db, slack.apiBase));
    const d = await decideAsPerson(s.db, b.ana, "billing-migration", "Freeze writes to the old invoices table from 18:00 UTC.");
    assert.equal((await processOutboundOnce(out(s.db, slack.apiBase))).posted, 1);
    assert.deepEqual([slack.requests[0]!.method, slack.requests[0]!.body.channel, slack.requests[0]!.body.thread_ts], ["chat.postMessage", CHANNEL.migration, undefined]);
    assert.equal(slack.requests[0]!.body.text, "Decision in billing-migration: Freeze writes to the old invoices table from 18:00 UTC.");
    await api(s.url, b.benAgent.token, `/v1/decisions/${d.id}/ack`, {});
    assert.equal((await processOutboundOnce(out(s.db, slack.apiBase))).posted, 1);
    assert.deepEqual([slack.requests[1]!.method, slack.requests[1]!.body.ts], ["chat.update", "1.000"]);
    assert.match(JSON.stringify(slack.requests[1]!.body.blocks), /Acknowledged by ben-agent/);
    assert.equal((await processOutboundOnce(out(s.db, slack.apiBase))).posted, 0);
  } finally {
    await s.stop();
    await slack.close();
  }
});

test("a suspected alert posts plain; its confirmation replies in its thread with @here, once", async () => {
  const slack = await fakeSlack();
  const s = await startTestServer();
  try {
    const b = await seedBilling(s.db);
    await processOutboundOnce(out(s.db, slack.apiBase));
    const { alert } = await api<{ alert: Alert }>(s.url, b.benAgent.token, "/v1/alerts", { room: "billing-prod", text: "Row counts for invoices differ by 12." });
    assert.equal((await processOutboundOnce(out(s.db, slack.apiBase))).posted, 1);
    assert.equal(slack.requests.length, 1);
    assert.deepEqual([slack.requests[0]!.body.channel, slack.requests[0]!.body.thread_ts], [CHANNEL.prod, undefined]);
    assert.ok(!JSON.stringify(slack.requests[0]!.body).includes("<!here>"));
    await api(s.url, b.benAgent.token, `/v1/alerts/${alert.id}/confirm`, { source: "ben" });
    assert.equal((await processOutboundOnce(out(s.db, slack.apiBase))).posted, 1);
    assert.equal(slack.requests.length, 2);
    const confirmed = slack.requests[1]!;
    assert.deepEqual([confirmed.body.thread_ts, confirmed.body.reply_broadcast], ["1.000", true]);
    assert.equal(confirmed.body.text, "<!here> Confirmed by ben-agent for ben: Row counts for invoices differ by 12.");
    assert.equal((await processOutboundOnce(out(s.db, slack.apiBase))).posted, 0);
    assert.equal((await getSlackPost(s.db, "alert", alert.id))?.loud, true);
  } finally {
    await s.stop();
    await slack.close();
  }
});

test("resolving an alert edits its message to say who resolved it, and pings no one", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      const b = await seedBilling(db);
      await processOutboundOnce(out(db, slack.apiBase));
      const a = await alertAsPerson(db, b.sam, "billing-prod", GAP);
      await processOutboundOnce(out(db, slack.apiBase));
      assert.equal((await getSlackPost(db, "alert", a.id))?.loud, true);
      const before = slack.requests.length;
      await resolveAlert(db, b.sam, a.id, {});
      assert.equal((await processOutboundOnce(out(db, slack.apiBase))).posted, 1);
      const sent = slack.requests.slice(before);
      assert.equal(sent.length, 1);
      assert.deepEqual([sent[0]!.method, sent[0]!.body.channel, sent[0]!.body.ts], ["chat.update", CHANNEL.prod, "1.000"]);
      assert.match(JSON.stringify(sent[0]!.body.blocks), /Resolved by sam/);
      assert.ok(!JSON.stringify(sent[0]!.body).includes("<!here>"));
      assert.equal((await processOutboundOnce(out(db, slack.apiBase))).posted, 0);

      await setRoom(db, "billing-migration", { slackAnnounce: "none" });
      const quiet = await raiseAlert(db, b.benAgent, { room: "billing-migration", text: GAP });
      await resolveAlert(db, b.ana, quiet.id, {});
      const n = slack.requests.length;
      await processOutboundOnce(out(db, slack.apiBase));
      assert.equal(slack.requests.length, n);

      const late = await raiseAlert(db, b.benAgent, { room: "billing-prod", text: GAP });
      await confirmAlert(db, b.sam, late.id, {});
      await resolveAlert(db, b.sam, late.id, {});
      const m = slack.requests.length;
      await processOutboundOnce(out(db, slack.apiBase));
      const pass = slack.requests.slice(m);
      const posts = pass.filter((r) => r.method === "chat.postMessage");
      assert.equal(posts.length, 1);
      assert.equal(posts[0]!.body.thread_ts, undefined);
      assert.match(JSON.stringify(posts[0]!.body.blocks), /Resolved by sam/);
      for (const r of pass) assert.ok(!JSON.stringify(r.body).includes("<!here>"), JSON.stringify(r.body));
    });
  } finally {
    await slack.close();
  }
});

test("a person's confirmed alert posts a single loud message", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      const b = await seedBilling(db);
      await processOutboundOnce(out(db, slack.apiBase));
      await alertAsPerson(db, b.sam, "billing-prod", GAP);
      assert.equal((await processOutboundOnce(out(db, slack.apiBase))).posted, 1);
      assert.equal(slack.requests.length, 1);
      assert.equal(slack.requests[0]!.body.thread_ts, undefined);
      const text = slack.requests[0]!.body.text as string;
      assert.equal(text, `<!here> Alert in billing-prod: ${GAP}`);
      assert.equal(text.split("<!here>").length, 2);
    });
  } finally {
    await slack.close();
  }
});

test("decision and alert text cannot ping the channel", async () => {
  const slack = await fakeSlack();
  const s = await startTestServer();
  try {
    const b = await seedBilling(s.db);
    await processOutboundOnce(out(s.db, slack.apiBase));
    await decideAsPerson(s.db, b.ana, "billing-migration", "<!channel> freeze now [x](http://evil.test)");
    await api(s.url, b.benAgent.token, "/v1/alerts", { room: "billing-prod", text: "<!here> fake alarm" });
    await processOutboundOnce(out(s.db, slack.apiBase));
    assert.equal(slack.requests.length, 2);
    for (const r of slack.requests) {
      const json = JSON.stringify(r.body);
      assert.ok(!json.includes("<!channel>") && !json.includes("](http") && !json.includes("<!here>"), json);
      assert.ok(json.includes("&lt;"), json);
    }
  } finally {
    await s.stop();
    await slack.close();
  }
});

test("announce none and an unlinked room post no decisions or alerts", async () => {
  const slack = await fakeSlack();
  try {
    await withTestDb(async (db) => {
      const b = await seedBilling(db);
      await processOutboundOnce(out(db, slack.apiBase));
      await setRoom(db, "billing-migration", { slackAnnounce: "none" });
      await setRoom(db, "billing-prod", { slackChannel: null });
      await decideAsPerson(db, b.ana, "billing-migration", "Freeze writes to the old invoices table from 18:00 UTC.");
      await alertAsPerson(db, b.sam, "billing-prod", GAP);
      assert.equal((await processOutboundOnce(out(db, slack.apiBase))).posted, 0);
      assert.equal(slack.requests.length, 0);
    });
  } finally {
    await slack.close();
  }
});
