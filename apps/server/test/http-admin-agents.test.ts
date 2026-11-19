import { test } from "node:test";
import assert from "node:assert/strict";
import { newId, newTokenSecret, type ActorRef, type AgentInfo } from "@copilotkit/teamkit-protocol";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
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

const REG = {
  name: "helper",
  url: "http://127.0.0.1:9000/agent",
  rooms: ["build"],
  headers: { Authorization: "Bearer s3cret-value" },
};

test("an admin registers, lists and disables an agent; header values never come back", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada", "admin");
    const res = await post(app, "/v1/admin/agents", cookie(ada.secret), REG);
    assert.equal(res.status, 201);
    const created = (await res.json()) as AgentInfo;
    assert.equal(created.name, "helper");
    assert.deepEqual(created.headerNames, ["Authorization"]);
    assert.equal(created.enabled, true);
    assert.ok(!JSON.stringify(created).includes("s3cret-value"));
    const [owner] = await db`select owner_id from actors where id = ${created.actor.id}`;
    assert.equal(owner!.owner_id, ada.actor.id);

    const list = await app.request("/v1/admin/agents", { headers: cookie(ada.secret) });
    assert.equal(list.status, 200);
    const text = await list.text();
    assert.ok(!text.includes("s3cret-value"));
    assert.deepEqual((JSON.parse(text) as AgentInfo[]).map((a) => a.name), ["helper"]);

    const off = await post(app, "/v1/admin/agents/helper/enabled", cookie(ada.secret), { enabled: false });
    assert.equal(off.status, 200);
    const info = (await off.json()) as AgentInfo;
    assert.equal(info.enabled, false);
    assert.ok(!JSON.stringify(info).includes("s3cret-value"));

    const missing = await post(app, "/v1/admin/agents/nope/enabled", cookie(ada.secret), { enabled: true });
    assert.equal(missing.status, 404);
    const bad = await post(app, "/v1/admin/agents/helper/enabled", cookie(ada.secret), { enabled: "yes" });
    assert.equal(bad.status, 400);
  });
});

test("members and agent tokens get 403", async () => {
  await withApp(async ({ db, app }) => {
    const bo = await signIn(db, "bo", "member");
    const tok = await createAgent(db, { name: "bot", ownerId: bo.actor.id, grants: [{ room: "*", perms: ["read"] }] });
    for (const h of [cookie(bo.secret), bearer(tok.token)]) {
      assert.equal((await app.request("/v1/admin/agents", { headers: h })).status, 403);
      assert.equal((await post(app, "/v1/admin/agents", h, REG)).status, 403);
      assert.equal((await post(app, "/v1/admin/agents/helper/enabled", h, { enabled: false })).status, 403);
    }
  });
});

test("an admin-scope token for an admin person is allowed", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada", "admin");
    const secret = newTokenSecret();
    await db`insert into tokens (id, actor_id, hash, scope) values (${newId("tok")}, ${ada.actor.id}, ${hashToken(secret)}, 'admin')`;
    assert.equal((await app.request("/v1/admin/agents", { headers: bearer(secret) })).status, 200);
  });
});

test("bad urls, credentials in the url, and bad bodies are invalid_input; private hosts are fine", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada", "admin");
    const h = cookie(ada.secret);
    for (const url of ["not a url", "ftp://example.com/a", "file:///etc/passwd", "javascript:alert(1)", "http://user:pw@example.com/a", "https://user@example.com/a"]) {
      const res = await post(app, "/v1/admin/agents", h, { ...REG, url });
      assert.equal(res.status, 400, url);
      assert.equal((await errorOf(res)).code, "invalid_input");
    }
    for (const patch of [{ rooms: undefined }, { rooms: [] }, { rooms: "build" }, { headers: { a: 1 } }, { headers: [] }, { name: "Bad Name" }]) {
      const res = await post(app, "/v1/admin/agents", h, { ...REG, ...patch });
      assert.equal(res.status, 400, JSON.stringify(patch));
      assert.equal((await errorOf(res)).code, "invalid_input");
    }
    for (const url of ["http://10.0.0.5:8080/a", "http://localhost:3000/a", "https://192.168.1.2/a"]) {
      const res = await post(app, "/v1/admin/agents", h, { ...REG, name: `a${Math.abs(url.length)}${url.length * 7}`, url });
      assert.equal(res.status, 201, url);
    }
  });
});
