import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db/pool.js";
import { withTestDb } from "./helpers/db.js";
import { agentToken } from "./helpers/server.js";
import { createNotifier } from "../src/notifier.js";
import { createApp } from "../src/http/app.js";
import { consumeSignInLink, invitePerson } from "../src/store/people.js";
import { createSlackLinkCode, findLinkedPerson } from "../src/slack/links.js";

type App = ReturnType<typeof createApp>;

async function withApp(fn: (ctx: { db: Db; app: App }) => Promise<void>): Promise<void> {
  await withTestDb(async (db) => {
    const notifier = await createNotifier(db);
    try {
      await fn({ db, app: createApp({ db, notifier }) });
    } finally {
      await notifier.close();
    }
  });
}

const post = (app: App, path: string, headers: Record<string, string>, body?: string) =>
  app.request(path, { method: "POST", headers, ...(body === undefined ? {} : { body }) });

async function signIn(db: Db, name: string) {
  const invite = await invitePerson(db, { name, role: "member" });
  const s = await consumeSignInLink(db, invite.secret);
  return { s, headers: { cookie: `teamkit_session=${s.sessionSecret}`, "content-type": "application/json" } };
}

test("a signed-in person previews, then redeems a fresh code; reuse is 404", async () => {
  await withApp(async ({ db, app }) => {
    const { s, headers } = await signIn(db, "ada");
    const code = await createSlackLinkCode(db, "U1", { slackUserName: "ada.l" });
    const preview = await post(app, "/v1/slack/link/preview", headers, JSON.stringify({ code }));
    assert.equal(preview.status, 200);
    const p = (await preview.json()) as { slackUserId: string; slackUserName: string; expiresAt: string };
    assert.deepEqual([p.slackUserId, p.slackUserName], ["U1", "ada.l"]);
    assert.equal(await findLinkedPerson(db, "U1"), null);

    const res = await post(app, "/v1/slack/link", headers, JSON.stringify({ code, slackUserId: "U1" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { slackUserId: "U1", slackUserName: "ada.l", actor: s.actor });
    assert.equal((await findLinkedPerson(db, "U1"))?.actor.id, s.actor.id);
    const again = await post(app, "/v1/slack/link", headers, JSON.stringify({ code, slackUserId: "U1" }));
    assert.equal(again.status, 404);
    const bad = await post(app, "/v1/slack/link/preview", headers, JSON.stringify({ code: "slk_nope" }));
    assert.equal(bad.status, 404);
  });
});

test("redeeming without the confirmed Slack user, or with another one, links nothing", async () => {
  await withApp(async ({ db, app }) => {
    const { headers } = await signIn(db, "ada");
    const code = await createSlackLinkCode(db, "U_MALLORY", { slackUserName: "ada" });
    const missing = await post(app, "/v1/slack/link", headers, JSON.stringify({ code }));
    assert.equal(missing.status, 400);
    const other = await post(app, "/v1/slack/link", headers, JSON.stringify({ code, slackUserId: "U_ADA" }));
    assert.equal(other.status, 400);
    assert.equal(await findLinkedPerson(db, "U_MALLORY"), null);
  });
});

test("a cookie with text/plain is 400, and the code stays unused", async () => {
  await withApp(async ({ db, app }) => {
    const { headers } = await signIn(db, "ada");
    const code = await createSlackLinkCode(db, "U2");
    const res = await post(
      app,
      "/v1/slack/link",
      { ...headers, "content-type": "text/plain" },
      JSON.stringify({ code, slackUserId: "U2" }),
    );
    assert.equal(res.status, 400);
    assert.equal(await findLinkedPerson(db, "U2"), null);
  });
});

test("an agent token is 403 on every Slack link route", async () => {
  await withApp(async ({ db, app }) => {
    const code = await createSlackLinkCode(db, "U3");
    const token = await agentToken(db, "bot");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const body = JSON.stringify({ code, slackUserId: "U3" });
    assert.equal((await post(app, "/v1/slack/link/preview", headers, body)).status, 403);
    assert.equal((await post(app, "/v1/slack/link", headers, body)).status, 403);
    assert.equal((await app.request("/v1/slack/links", { headers })).status, 403);
    assert.equal((await post(app, "/v1/slack/links/U3/unlink", headers)).status, 403);
    assert.equal(await findLinkedPerson(db, "U3"), null);
  });
});

test("a person lists their linked Slack users and unlinks one", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada");
    const bob = await signIn(db, "bob");
    for (const [who, id] of [
      [ada, "U1"],
      [ada, "U9"],
      [bob, "U2"],
    ] as const) {
      const code = await createSlackLinkCode(db, id, { slackUserName: `h${id}` });
      const r = await post(app, "/v1/slack/link", who.headers, JSON.stringify({ code, slackUserId: id }));
      assert.equal(r.status, 200);
    }
    const list = async () => {
      const r = await app.request("/v1/slack/links", { headers: { cookie: ada.headers.cookie } });
      assert.equal(r.status, 200);
      const body = (await r.json()) as { links: { slackUserId: string; slackUserName: string }[] };
      return body.links.map((l) => `${l.slackUserId}:${l.slackUserName}`);
    };
    assert.deepEqual(await list(), ["U1:hU1", "U9:hU9"]);
    assert.equal((await post(app, "/v1/slack/links/U2/unlink", ada.headers)).status, 404);
    assert.equal((await post(app, "/v1/slack/links/U9/unlink", ada.headers)).status, 200);
    assert.deepEqual(await list(), ["U1:hU1"]);
    assert.equal(await findLinkedPerson(db, "U9"), null);
    assert.equal((await findLinkedPerson(db, "U2"))?.actor.id, bob.s.actor.id);
  });
});
