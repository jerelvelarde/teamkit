import { test } from "node:test";
import assert from "node:assert/strict";
import { type ActorRef, type CreatedTrigger, type TriggerInfo } from "@copilotkit/teamkit-protocol";
import type { Db } from "../src/db/pool.js";
import { withTestDb } from "./helpers/db.js";
import { createNotifier } from "../src/notifier.js";
import { createApp } from "../src/http/app.js";
import { consumeSignInLink, invitePerson } from "../src/store/people.js";
import { createAgent } from "../src/store/actors.js";

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

async function signIn(db: Db, name: string, role: "admin" | "member"): Promise<{ actor: ActorRef; secret: string }> {
  const invite = await invitePerson(db, { name, role });
  const s = await consumeSignInLink(db, invite.secret);
  return { actor: s.actor, secret: s.sessionSecret };
}

const cookie = (secret: string) => ({ cookie: `teamkit_session=${secret}`, "content-type": "application/json" });
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

const post = (app: App, path: string, headers: Record<string, string>, body: unknown = {}) =>
  app.request(path, { method: "POST", headers, body: JSON.stringify(body) });

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

const TRIG = { name: "on-done", room: "build", kinds: ["task.completed"], webhook: "https://example.com/hook" };

test("an admin adds a webhook trigger, lists without secrets, disables and removes it", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada", "admin");
    const h = cookie(ada.secret);
    const res = await post(app, "/v1/admin/triggers", h, TRIG);
    assert.equal(res.status, 201);
    const created = (await res.json()) as CreatedTrigger;
    assert.match(created.secret ?? "", /^whsec_/);
    assert.equal(created.trigger.name, "on-done");
    assert.ok(!("secret" in created.trigger));
    const [row] = await db`select created_by from triggers where name = 'on-done'`;
    assert.equal(row!.created_by, ada.actor.id);

    const list = await app.request("/v1/admin/triggers", { headers: h });
    assert.equal(list.status, 200);
    const text = await list.text();
    assert.ok(!text.includes(created.secret!));
    assert.ok(!text.includes("secret"));
    assert.deepEqual((JSON.parse(text) as TriggerInfo[]).map((t) => t.name), ["on-done"]);

    const off = await post(app, "/v1/admin/triggers/on-done/enabled", h, { enabled: false });
    assert.equal(off.status, 200);
    const info = (await off.json()) as TriggerInfo;
    assert.equal(info.enabled, false);
    assert.ok(!JSON.stringify(info).includes(created.secret!));
    assert.equal((await post(app, "/v1/admin/triggers/on-done/enabled", h, { enabled: "no" })).status, 400);
    assert.equal((await post(app, "/v1/admin/triggers/nope/enabled", h, { enabled: true })).status, 404);

    const rm = await post(app, "/v1/admin/triggers/on-done/remove", h);
    assert.equal(rm.status, 200);
    assert.deepEqual(await rm.json(), { ok: true });
    assert.deepEqual(await (await app.request("/v1/admin/triggers", { headers: h })).json(), []);
    assert.equal((await post(app, "/v1/admin/triggers/on-done/remove", h)).status, 404);
  });
});

test("members and agent tokens get 403", async () => {
  await withApp(async ({ db, app }) => {
    const bo = await signIn(db, "bo", "member");
    const tok = await createAgent(db, { name: "bot", ownerId: bo.actor.id, grants: [{ room: "*", perms: ["read"] }] });
    for (const h of [cookie(bo.secret), bearer(tok.token)]) {
      assert.equal((await app.request("/v1/admin/triggers", { headers: h })).status, 403);
      assert.equal((await post(app, "/v1/admin/triggers", h, TRIG)).status, 403);
      assert.equal((await post(app, "/v1/admin/triggers/x/remove", h)).status, 403);
      assert.equal((await post(app, "/v1/admin/triggers/x/enabled", h, { enabled: false })).status, 403);
    }
  });
});

test("bad kinds, bad webhook urls and bad bodies are invalid_input", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada", "admin");
    const h = cookie(ada.secret);
    const bads: Record<string, unknown>[] = [
      { kinds: ["nonsense"] },
      { kinds: [] },
      { kinds: "task.completed" },
      { kinds: undefined },
      { webhook: "not a url" },
      { webhook: "ftp://example.com/a" },
      { webhook: "javascript:alert(1)" },
      { webhook: "http://user:pw@example.com/a" },
      { webhook: "https://user@example.com/a" },
      { webhook: undefined },
      { webhook: 5 },
      { name: "Bad Name" },
      { name: undefined },
      { room: undefined },
    ];
    for (const patch of bads) {
      const res = await post(app, "/v1/admin/triggers", h, { ...TRIG, ...patch });
      assert.equal(res.status, 400, JSON.stringify(patch));
      assert.equal((await errorOf(res)).code, "invalid_input");
    }
    assert.deepEqual(await (await app.request("/v1/admin/triggers", { headers: h })).json(), []);
  });
});
