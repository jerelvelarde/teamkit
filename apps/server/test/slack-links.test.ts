import { test } from "node:test";
import assert from "node:assert/strict";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import {
  SLACK_LINK_TTL_MS,
  createSlackLinkCode,
  findLinkedPerson,
  listMySlackLinks,
  previewSlackLinkCode,
  redeemSlackLinkCode,
  slackLinkUrl,
  unlinkMySlackUser,
  unlinkSlackUser,
} from "../src/slack/links.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("code redeemed by a person links the Slack user; only the hash is stored", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada");
    const c = await createSlackLinkCode(db, "U1", { slackUserName: "ada.l" });
    assert.match(c, /^slk_[A-Za-z0-9_-]{43}$/);
    assert.equal(slackLinkUrl("http://x.test/", c), `http://x.test/link/slack?code=${c}`);
    const [row] = await db`select hash from slack_link_codes`;
    assert.equal(row!.hash, hashToken(c));
    assert.equal(await findLinkedPerson(db, "U1"), null);
    const r = await redeemSlackLinkCode(db, ada, c, "U1");
    assert.deepEqual([r.slackUserId, r.slackUserName, r.actor.id], ["U1", "ada.l", ada.actor.id]);
    const linked = await findLinkedPerson(db, "U1");
    assert.equal(linked?.actor.id, ada.actor.id);
    assert.equal(linked?.role, "member");
  });
});

test("a code lives ten minutes", async () => {
  await withTestDb(async (db) => {
    assert.equal(SLACK_LINK_TTL_MS, 600_000);
    const ada = await personAuth(db, "ada");
    const p = await previewSlackLinkCode(db, ada, await createSlackLinkCode(db, "U1"));
    const left = Date.parse(p.expiresAt) - Date.now();
    assert.ok(left > 590_000 && left <= 600_000, `expires in ${left} ms`);
  });
});

test("preview names the Slack user and handle without using the code up", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada");
    const c = await createSlackLinkCode(db, "U_MALLORY", { slackUserName: "@mallory\u0007 " });
    const p = await previewSlackLinkCode(db, ada, c);
    assert.equal(p.slackUserId, "U_MALLORY");
    assert.equal(p.slackUserName, "mallory");
    assert.deepEqual(await previewSlackLinkCode(db, ada, c), p);
    assert.equal(await findLinkedPerson(db, "U_MALLORY"), null);
    const noName = await createSlackLinkCode(db, "U2", { slackUserName: "  " });
    assert.equal((await previewSlackLinkCode(db, ada, noName)).slackUserName, null);
    await assert.rejects(previewSlackLinkCode(db, ada, "slk_nope"), code("not_found"));
    await assert.rejects(previewSlackLinkCode(db, await agentAuth(db, "bot"), c), code("forbidden"));
  });
});

test("redeeming needs the confirmed Slack user id; a mismatch leaves the code unused", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada");
    const c = await createSlackLinkCode(db, "U_MALLORY", { slackUserName: "ada" });
    await assert.rejects(redeemSlackLinkCode(db, ada, c, "U_ADA"), code("invalid_input"));
    assert.equal(await findLinkedPerson(db, "U_MALLORY"), null);
    assert.equal((await previewSlackLinkCode(db, ada, c)).slackUserId, "U_MALLORY");
  });
});

test("a code is single-use and expires", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada");
    const c = await createSlackLinkCode(db, "U1");
    await redeemSlackLinkCode(db, ada, c, "U1");
    await assert.rejects(redeemSlackLinkCode(db, ada, c, "U1"), code("not_found"));
    await assert.rejects(previewSlackLinkCode(db, ada, c), code("not_found"));
    const short = await createSlackLinkCode(db, "U2", { ttlMs: 1 });
    await sleep(10);
    await assert.rejects(redeemSlackLinkCode(db, ada, short, "U2"), code("not_found"));
    await assert.rejects(redeemSlackLinkCode(db, ada, "slk_nope", "U1"), code("not_found"));
  });
});

test("each new code deletes the expired ones", async () => {
  await withTestDb(async (db) => {
    await createSlackLinkCode(db, "U1", { ttlMs: 1 });
    await createSlackLinkCode(db, "U2", { ttlMs: 1 });
    await sleep(10);
    await createSlackLinkCode(db, "U3");
    const rows = await db`select slack_user_id from slack_link_codes`;
    assert.deepEqual(rows.map((r) => r.slack_user_id), ["U3"]);
  });
});

test("an agent token can never link a Slack identity", async () => {
  await withTestDb(async (db) => {
    const agent = await agentAuth(db, "bot");
    const c = await createSlackLinkCode(db, "U1");
    await assert.rejects(redeemSlackLinkCode(db, agent, c, "U1"), code("forbidden"));
    // the failed attempt did not burn the code
    const ada = await personAuth(db, "ada");
    await redeemSlackLinkCode(db, ada, c, "U1");
  });
});

test("re-linking moves the Slack user; unlink removes it", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada");
    const bob = await personAuth(db, "bob", "admin");
    await redeemSlackLinkCode(db, ada, await createSlackLinkCode(db, "U1"), "U1");
    await redeemSlackLinkCode(db, bob, await createSlackLinkCode(db, "U1"), "U1");
    const linked = await findLinkedPerson(db, "U1");
    assert.equal(linked?.actor.id, bob.actor.id);
    assert.equal(linked?.role, "admin");
    assert.equal(await unlinkSlackUser(db, "U1"), true);
    assert.equal(await findLinkedPerson(db, "U1"), null);
    assert.equal(await unlinkSlackUser(db, "U1"), false);
  });
});

test("a person lists and unlinks only their own Slack users", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada");
    const bob = await personAuth(db, "bob");
    await redeemSlackLinkCode(db, ada, await createSlackLinkCode(db, "U1", { slackUserName: "ada" }), "U1");
    await redeemSlackLinkCode(db, ada, await createSlackLinkCode(db, "U_MALLORY", { slackUserName: "mal" }), "U_MALLORY");
    await redeemSlackLinkCode(db, bob, await createSlackLinkCode(db, "U2"), "U2");
    const mine = await listMySlackLinks(db, ada);
    assert.deepEqual(
      mine.map((l) => [l.slackUserId, l.slackUserName]),
      [
        ["U1", "ada"],
        ["U_MALLORY", "mal"],
      ],
    );
    assert.ok(mine.every((l) => !Number.isNaN(Date.parse(l.linkedAt))));
    await assert.rejects(unlinkMySlackUser(db, ada, "U2"), code("not_found"));
    assert.equal((await findLinkedPerson(db, "U2"))?.actor.id, bob.actor.id);
    await unlinkMySlackUser(db, ada, "U_MALLORY");
    assert.equal(await findLinkedPerson(db, "U_MALLORY"), null);
    assert.deepEqual((await listMySlackLinks(db, ada)).map((l) => l.slackUserId), ["U1"]);
    await assert.rejects(listMySlackLinks(db, await agentAuth(db, "bot")), code("forbidden"));
  });
});
