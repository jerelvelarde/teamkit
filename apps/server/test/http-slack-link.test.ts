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

const post = (app: App, headers: Record<string, string>, body: string) =>
  app.request("/v1/slack/link", { method: "POST", headers, body });

test("a signed-in person redeems a fresh code; reuse is 404", async () => {
  await withApp(async ({ db, app }) => {
    const invite = await invitePerson(db, { name: "ada", role: "member" });
    const s = await consumeSignInLink(db, invite.secret);
    const headers = { cookie: `teamkit_session=${s.sessionSecret}`, "content-type": "application/json" };
    const code = await createSlackLinkCode(db, "U1");
    const res = await post(app, headers, JSON.stringify({ code }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { slackUserId: "U1", actor: s.actor });
    assert.equal((await findLinkedPerson(db, "U1"))?.actor.id, s.actor.id);
    const again = await post(app, headers, JSON.stringify({ code }));
    assert.equal(again.status, 404);
    const bad = await post(app, headers, JSON.stringify({ code: "slk_nope" }));
    assert.equal(bad.status, 404);
  });
});

test("a cookie with text/plain is 400, and the code stays unused", async () => {
  await withApp(async ({ db, app }) => {
    const invite = await invitePerson(db, { name: "ada", role: "member" });
    const s = await consumeSignInLink(db, invite.secret);
    const code = await createSlackLinkCode(db, "U2");
    const res = await post(
      app,
      { cookie: `teamkit_session=${s.sessionSecret}`, "content-type": "text/plain" },
      JSON.stringify({ code }),
    );
    assert.equal(res.status, 400);
    assert.equal(await findLinkedPerson(db, "U2"), null);
  });
});

test("an agent token is 403", async () => {
  await withApp(async ({ db, app }) => {
    const code = await createSlackLinkCode(db, "U3");
    const token = await agentToken(db, "bot");
    const res = await post(
      app,
      { authorization: `Bearer ${token}`, "content-type": "application/json" },
      JSON.stringify({ code }),
    );
    assert.equal(res.status, 403);
    assert.equal(await findLinkedPerson(db, "U3"), null);
  });
});
