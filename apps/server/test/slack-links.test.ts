import { test } from "node:test";
import assert from "node:assert/strict";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import {
  createSlackLinkCode,
  findLinkedPerson,
  redeemSlackLinkCode,
  slackLinkUrl,
  unlinkSlackUser,
} from "../src/slack/links.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("code redeemed by a person links the Slack user; only the hash is stored", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada");
    const c = await createSlackLinkCode(db, "U1");
    assert.match(c, /^slk_[A-Za-z0-9_-]{43}$/);
    assert.equal(slackLinkUrl("http://x.test/", c), `http://x.test/link/slack?code=${c}`);
    const [row] = await db`select hash from slack_link_codes`;
    assert.equal(row!.hash, hashToken(c));
    assert.equal(await findLinkedPerson(db, "U1"), null);
    const r = await redeemSlackLinkCode(db, ada, c);
    assert.equal(r.slackUserId, "U1");
    assert.equal(r.actor.id, ada.actor.id);
    const linked = await findLinkedPerson(db, "U1");
    assert.equal(linked?.actor.id, ada.actor.id);
    assert.equal(linked?.role, "member");
  });
});

test("a code is single-use and expires", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada");
    const c = await createSlackLinkCode(db, "U1");
    await redeemSlackLinkCode(db, ada, c);
    await assert.rejects(redeemSlackLinkCode(db, ada, c), code("not_found"));
    const short = await createSlackLinkCode(db, "U2", 1);
    await sleep(10);
    await assert.rejects(redeemSlackLinkCode(db, ada, short), code("not_found"));
    await assert.rejects(redeemSlackLinkCode(db, ada, "slk_nope"), code("not_found"));
  });
});

test("an agent token can never link a Slack identity", async () => {
  await withTestDb(async (db) => {
    const agent = await agentAuth(db, "bot");
    const c = await createSlackLinkCode(db, "U1");
    await assert.rejects(redeemSlackLinkCode(db, agent, c), code("forbidden"));
    // the failed attempt did not burn the code
    const ada = await personAuth(db, "ada");
    await redeemSlackLinkCode(db, ada, c);
  });
});

test("re-linking moves the Slack user; unlink removes it", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada");
    const bob = await personAuth(db, "bob", "admin");
    await redeemSlackLinkCode(db, ada, await createSlackLinkCode(db, "U1"));
    await redeemSlackLinkCode(db, bob, await createSlackLinkCode(db, "U1"));
    const linked = await findLinkedPerson(db, "U1");
    assert.equal(linked?.actor.id, bob.actor.id);
    assert.equal(linked?.role, "admin");
    assert.equal(await unlinkSlackUser(db, "U1"), true);
    assert.equal(await findLinkedPerson(db, "U1"), null);
    assert.equal(await unlinkSlackUser(db, "U1"), false);
  });
});
