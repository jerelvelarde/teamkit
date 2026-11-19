import { test } from "node:test";
import assert from "node:assert/strict";
import { newId, newTokenSecret, type ActorRef, type CreatedToken, type Invite, type PersonInfo, type RoomInfo, type TokenInfo } from "@copilotkit/teamkit-protocol";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import type { Db } from "../src/db/pool.js";
import { withTestDb } from "./helpers/db.js";
import { createNotifier } from "../src/notifier.js";
import { createApp } from "../src/http/app.js";
import { consumeSignInLink, invitePerson } from "../src/store/people.js";

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

async function adminScopeToken(db: Db, actorId: string): Promise<string> {
  const secret = newTokenSecret();
  await db`insert into tokens (id, actor_id, hash, scope) values (${newId("tok")}, ${actorId}, ${hashToken(secret)}, 'admin')`;
  return secret;
}

const cookie = (secret: string) => ({ cookie: `teamkit_session=${secret}`, "content-type": "application/json" });
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

async function post(app: App, path: string, headers: Record<string, string>, body: unknown = {}): Promise<Response> {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

const WORKER = { name: "worker", rooms: [{ room: "build", perms: ["read", "post", "claim"] }], count: 2 };

test("an admin session creates owned agent tokens, which authenticate", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada", "admin");
    const res = await post(app, "/v1/admin/tokens", cookie(ada.secret), WORKER);
    assert.equal(res.status, 201);
    const { tokens } = (await res.json()) as { tokens: CreatedToken[] };
    assert.deepEqual(tokens.map((t) => t.actor.name), ["worker-1", "worker-2"]);
    for (const t of tokens) {
      const who = await app.request("/v1/whoami", { headers: bearer(t.token) });
      assert.equal(who.status, 200);
      const [row] = await db`select owner_id from actors where id = ${t.actor.id}`;
      assert.equal(row!.owner_id, ada.actor.id);
    }
    // Secrets are shown once: the listing has none.
    const list = await app.request("/v1/admin/tokens", { headers: cookie(ada.secret) });
    const infos = (await list.json()) as (TokenInfo & { token?: string })[];
    assert.equal(infos.length, 2);
    assert.ok(infos.every((i) => i.token === undefined));
    assert.ok(!JSON.stringify(infos).includes(tokens[0]!.token));
  });
});

test("a single token without count; bad rooms are invalid_input", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada", "admin");
    const one = await post(app, "/v1/admin/tokens", cookie(ada.secret), { name: "solo", rooms: [{ room: "*", perms: ["read"] }] });
    assert.equal(one.status, 201);
    assert.equal(((await one.json()) as { tokens: CreatedToken[] }).tokens[0]!.actor.name, "solo");
    for (const rooms of [undefined, [], "build", [{ room: "build" }]]) {
      const res = await post(app, "/v1/admin/tokens", cookie(ada.secret), { name: "x", rooms });
      assert.equal(res.status, 400);
      assert.equal((await errorOf(res)).code, "invalid_input");
    }
  });
});

test("members, member admin-scope tokens and agent tokens are refused; an admin's admin-scope token works", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada", "admin");
    const bob = await signIn(db, "bob", "member");

    const member = await post(app, "/v1/admin/tokens", cookie(bob.secret), WORKER);
    assert.equal(member.status, 403);
    assert.deepEqual(await errorOf(member), { code: "forbidden", message: "admins only" });

    const memberScoped = await post(app, "/v1/admin/tokens", bearer(await adminScopeToken(db, bob.actor.id)), WORKER);
    assert.equal(memberScoped.status, 403);

    const adminScoped = await post(app, "/v1/admin/tokens", bearer(await adminScopeToken(db, ada.actor.id)), WORKER);
    assert.equal(adminScoped.status, 201);

    const agent = ((await (await post(app, "/v1/admin/tokens", cookie(ada.secret), { name: "bot", rooms: [{ room: "*", perms: ["read"] }] })).json()) as { tokens: CreatedToken[] }).tokens[0]!;
    for (const [m, path] of [["GET", "/v1/admin/people"], ["GET", "/v1/admin/tokens"], ["GET", "/v1/admin/rooms"]] as const) {
      const res = await app.request(path, { method: m, headers: bearer(agent.token) });
      assert.equal(res.status, 403, path);
    }
    assert.equal((await post(app, "/v1/admin/tokens", bearer(agent.token), WORKER)).status, 403);
  });
});

test("revoking a token stops it authenticating", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada", "admin");
    const { tokens } = (await (await post(app, "/v1/admin/tokens", cookie(ada.secret), WORKER)).json()) as { tokens: CreatedToken[] };
    const t = tokens[0]!;
    assert.equal((await app.request("/v1/whoami", { headers: bearer(t.token) })).status, 200);
    const res = await post(app, `/v1/admin/tokens/${t.tokenId}/revoke`, cookie(ada.secret));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal((await app.request("/v1/whoami", { headers: bearer(t.token) })).status, 401);
    assert.equal((await post(app, "/v1/admin/tokens/tok_nope/revoke", cookie(ada.secret))).status, 404);
  });
});

test("room settings are set and listed", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada", "admin");
    const res = await post(app, "/v1/admin/rooms/build", cookie(ada.secret), { approvers: ["ada"], slackAnnounce: "all" });
    assert.equal(res.status, 200);
    const info = (await res.json()) as RoomInfo;
    assert.equal(info.name, "build");
    assert.deepEqual(info.approvers, ["ada"]);
    assert.equal(info.slackAnnounce, "all");
    // Keys not sent are left unchanged.
    const again = (await (await post(app, "/v1/admin/rooms/build", cookie(ada.secret), { agent: "worker-1" })).json()) as RoomInfo;
    assert.deepEqual(again.approvers, ["ada"]);
    assert.equal(again.agent, "worker-1");
    const list = (await (await app.request("/v1/admin/rooms", { headers: cookie(ada.secret) })).json()) as RoomInfo[];
    assert.deepEqual(list.map((r) => r.name), ["build"]);
    const bad = await post(app, "/v1/admin/rooms/build", cookie(ada.secret), { slackAnnounce: "loud" });
    assert.equal(bad.status, 400);
  });
});

test("an admin session invites a person, and the link signs them in as a member", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada", "admin");
    const res = await post(app, "/v1/admin/people", cookie(ada.secret), { name: "bob" });
    assert.equal(res.status, 201);
    const invite = (await res.json()) as Invite;
    assert.equal(invite.person.name, "bob");
    assert.equal(invite.role, "member");
    assert.match(invite.link, /^http:\/\/127\.0\.0\.1:3000\/signin\/sl_/);
    const secret = invite.link.split("/signin/")[1]!;
    const si = await app.request("/v1/signin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) });
    assert.equal(si.status, 200);
    assert.equal(((await si.json()) as { role: string }).role, "member");

    const relink = await post(app, "/v1/admin/people/bob/link", cookie(ada.secret));
    assert.equal(relink.status, 200);
    assert.match(((await relink.json()) as { link: string }).link, /\/signin\/sl_/);
    assert.equal((await post(app, "/v1/admin/people/nobody/link", cookie(ada.secret))).status, 404);
  });
});

test("people can be listed with a session or an admin-scope token", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada", "admin");
    await post(app, "/v1/admin/people", cookie(ada.secret), { name: "bob" });
    const viaSession = (await (await app.request("/v1/admin/people", { headers: cookie(ada.secret) })).json()) as PersonInfo[];
    assert.deepEqual(viaSession.map((p) => p.actor.name), ["ada", "bob"]);
    const scoped = await adminScopeToken(db, ada.actor.id);
    const viaToken = await app.request("/v1/admin/people", { headers: bearer(scoped) });
    assert.equal(viaToken.status, 200);
    assert.equal(((await viaToken.json()) as PersonInfo[]).length, 2);
  });
});

test("an admin-scope token cannot mint sign-in links", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada", "admin");
    const scoped = bearer(await adminScopeToken(db, ada.actor.id));
    const message = "inviting people needs an admin signed in on the web board";
    const [{ n: linksBefore }] = (await db`select count(*)::int as n from signin_links`) as unknown as { n: number }[];

    const invite = await post(app, "/v1/admin/people", scoped, { name: "eve" });
    assert.equal(invite.status, 403);
    assert.deepEqual(await errorOf(invite), { code: "forbidden", message });
    const [eve] = await db`select 1 as x from actors where name = 'eve'`;
    assert.equal(eve, undefined);

    const link = await post(app, "/v1/admin/people/ada/link", scoped);
    assert.equal(link.status, 403);
    assert.deepEqual(await errorOf(link), { code: "forbidden", message });
    const [{ n: linksAfter }] = (await db`select count(*)::int as n from signin_links`) as unknown as { n: number }[];
    assert.equal(linksAfter, linksBefore);
  });
});
