import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Hono } from "hono";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { verifySlackSignature } from "../src/slack/commands.js";
import { entityIdOf, loadAlert, loadDecision } from "../src/slack/coordination.js";
import { NOT_MAPPED } from "../src/slack/handlers.js";
import { listEvents } from "../src/store/events.js";
import { CHANNEL, SLACK_USER, seedBilling } from "./helpers/billing.js";
import { withTestDb } from "./helpers/db.js";
import { idleNotifier } from "./helpers/fake-slack.js";

const SECRET = "test-signing-secret-billing-migration";
const USAGE = "Use `/teamkit decide <what was decided>` or `/teamkit alert <what is wrong>` in a channel linked to a TeamKit room.";
const sign = (secret: string, ts: number, body: string) => "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
const form = (fields: { text: string; user_id?: string; channel_id?: string; user_name?: string }) => new URLSearchParams({
  command: "/teamkit", team_id: "T0BILLING", user_name: "ana", response_url: "https://hooks.slack.invalid/commands/1", trigger_id: "1.2.3",
  user_id: SLACK_USER.ana, channel_id: CHANNEL.migration, ...fields,
}).toString();
async function send(app: Hono<any>, body: string, opts: { ts?: number; secret?: string; signature?: string | null } = {}) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": String(ts) };
  if (opts.signature !== null) headers["x-slack-signature"] = opts.signature ?? sign(opts.secret ?? SECRET, ts, body);
  return app.request("/v1/slack/commands", { method: "POST", headers, body });
}
/** `null` builds the app with no signing secret (passing undefined would take the default). */
const appFor = (db: Db, secret: string | null = SECRET) =>
  createApp({ db, notifier: idleNotifier, publicUrl: "http://board.test", ...(secret === null ? {} : { slackSigningSecret: secret }) });
const kindsOf = async (db: Db) => (await listEvents(db, { kinds: ["decision.posted", "alert.raised"] })).events.map((e) => e.kind);
const replyOf = async (res: Response) => ((await res.json()) as { text: string }).text;

test("verifySlackSignature accepts Slack's v0 signature and refuses a wrong, old or missing one", () => {
  const now = 1_763_560_000_000;
  const ts = Math.floor(now / 1000);
  const body = form({ text: "decide Freeze writes to the old invoices table from 18:00 UTC." });
  const good = { signature: sign(SECRET, ts, body), timestamp: String(ts) };
  assert.equal(verifySlackSignature(SECRET, good, body, now), true);
  assert.equal(verifySlackSignature(SECRET, good, body + "&x=1", now), false);
  assert.equal(verifySlackSignature("another-secret", good, body, now), false);
  assert.equal(verifySlackSignature(SECRET, good, body, now + 301_000), false);
  assert.equal(verifySlackSignature(SECRET, good, body, now - 301_000), false);
  assert.equal(verifySlackSignature(SECRET, { ...good, signature: undefined }, body, now), false);
  assert.equal(verifySlackSignature(SECRET, { ...good, timestamp: "soon" }, body, now), false);
  assert.equal(verifySlackSignature(SECRET, { ...good, signature: "v0=abc" }, body, now), false);
});

test("a linked person's /teamkit decide records the decision in the channel's room", async () => {
  await withTestDb(async (db) => {
    await seedBilling(db);
    const res = await send(appFor(db), form({ text: "decide Freeze writes to the old invoices table from 18:00 UTC." }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { response_type: "ephemeral", text: "Decision recorded in billing-migration." });
    const [e] = (await listEvents(db, { kinds: ["decision.posted"] })).events;
    const d = await loadDecision(db, entityIdOf(e!)!);
    assert.deepEqual([d?.room, d?.decidedBy.name, d?.text], ["billing-migration", "ana", "Freeze writes to the old invoices table from 18:00 UTC."]);
  });
});

test("a linked person's /teamkit alert raises a confirmed alert", async () => {
  await withTestDb(async (db) => {
    await seedBilling(db);
    const res = await send(appFor(db), form({ text: "alert Invoice totals differ between the old and new database.", user_id: SLACK_USER.sam, user_name: "sam", channel_id: CHANNEL.prod }));
    assert.equal(await replyOf(res), "Alert raised in billing-prod and confirmed by you.");
    const [e] = (await listEvents(db, { kinds: ["alert.raised"] })).events;
    const a = await loadAlert(db, entityIdOf(e!)!);
    assert.deepEqual([a?.level, a?.confirmedBy?.name, a?.room], ["confirmed", "sam", "billing-prod"]);
  });
});

test("an unlinked Slack user gets a link prompt, and nothing is recorded", async () => {
  await withTestDb(async (db) => {
    await seedBilling(db, { linkSlack: false });
    const res = await send(appFor(db), form({ text: "decide Freeze writes to the old invoices table from 18:00 UTC." }));
    assert.match(await replyOf(res), /^To use \/teamkit, link your Slack account first: http:\/\/board\.test\/link\/slack\?code=slk_/);
    assert.deepEqual(await kindsOf(db), []);
  });
});

test("a channel not linked to a room is refused, with no fallback to a default room", async () => {
  await withTestDb(async (db) => {
    await seedBilling(db);
    const res = await send(appFor(db), form({ text: "decide Freeze writes to the old invoices table from 18:00 UTC.", channel_id: "C0NOTLINKED" }));
    assert.equal(await replyOf(res), NOT_MAPPED);
    assert.deepEqual(await kindsOf(db), []);
  });
});

test("an empty or unknown subcommand gets the usage line", async () => {
  await withTestDb(async (db) => {
    await seedBilling(db);
    const app = appFor(db);
    for (const text of ["", "rollcall billing-migration", "decide", "DECIDE   "]) {
      assert.equal(await replyOf(await send(app, form({ text }))), USAGE, text);
    }
    assert.deepEqual(await kindsOf(db), []);
  });
});

test("forged, replayed or unsigned commands are refused and record nothing", async () => {
  await withTestDb(async (db) => {
    await seedBilling(db);
    const app = appFor(db);
    const body = form({ text: "alert Invoice totals differ between the old and new database." });
    assert.equal((await send(app, body, { secret: "not-the-secret" })).status, 401);
    assert.equal((await send(app, body, { ts: Math.floor(Date.now() / 1000) - 600 })).status, 401);
    assert.equal((await send(app, body, { signature: null })).status, 401);
    assert.deepEqual(await kindsOf(db), []);
  });
});

test("without SLACK_SIGNING_SECRET the route is off", async () => {
  await withTestDb(async (db) => {
    await seedBilling(db);
    const res = await send(appFor(db, null), form({ text: "decide Freeze writes to the old invoices table from 18:00 UTC." }));
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "not_found");
    assert.deepEqual(await kindsOf(db), []);
  });
});
