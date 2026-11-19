import { test } from "node:test";
import assert from "node:assert/strict";
import { newId, newTokenSecret, type ActorRef, type CreatedJoinLink, type JoinLink, type Role, type Whoami } from "@copilotkit/teamkit-protocol";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import type { Db } from "../src/db/pool.js";
import { withTestDb } from "./helpers/db.js";
import { createNotifier } from "../src/notifier.js";
import { createApp, type AppOptions } from "../src/http/app.js";
import { consumeSignInLink, invitePerson } from "../src/store/people.js";
import { createJoinLink } from "../src/store/join.js";
import { agentAuth } from "./helpers/actors.js";

type App = ReturnType<typeof createApp>;

async function withApp(
  fn: (ctx: { db: Db; app: App }) => Promise<void>,
  publicUrl?: string,
  opts?: AppOptions,
): Promise<void> {
  await withTestDb(async (db) => {
    const notifier = await createNotifier(db);
    try {
      await fn({ db, app: createApp({ db, notifier, publicUrl }, opts) });
    } finally {
      await notifier.close();
    }
  });
}

const JSON_TYPE = { "content-type": "application/json" };
const post = (app: App, path: string, body: unknown, headers: Record<string, string> = JSON_TYPE) =>
  app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
const cookieOf = (res: Response): string => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function adminScopeToken(db: Db, actorId: string): Promise<string> {
  const secret = newTokenSecret();
  await db`insert into tokens (id, actor_id, hash, scope) values (${newId("tok")}, ${actorId}, ${hashToken(secret)}, 'admin')`;
  return secret;
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

async function signIn(db: Db, name: string, role: Role): Promise<{ actor: ActorRef; cookie: string }> {
  const invite = await invitePerson(db, { name, role });
  const s = await consumeSignInLink(db, invite.secret);
  return { actor: s.actor, cookie: `teamkit_session=${s.sessionSecret}` };
}

test("an admin on the web board creates a join link shown once; an admin-scope token lists and revokes it", async () => {
  await withApp(async ({ db, app }) => {
    const sam = await signIn(db, "sam", "admin");
    const res = await post(app, "/v1/admin/join-links", { expiresInDays: 30, domains: ["example.com"] }, { ...JSON_TYPE, cookie: sam.cookie });
    assert.equal(res.status, 201);
    const created = (await res.json()) as CreatedJoinLink;
    assert.match(created.link, /^http:\/\/127\.0\.0\.1:3000\/join\/jc_[A-Za-z0-9_-]{43}$/);
    const { link: _shownOnce, ...listed } = created;
    const auth = { authorization: `Bearer ${await adminScopeToken(db, sam.actor.id)}` };
    const links = (await (await app.request("/v1/admin/join-links", { headers: auth })).json()) as JoinLink[];
    assert.deepEqual(links, [listed]);
    assert.ok(!JSON.stringify(links).includes("jc_"));
    const rv = await post(app, `/v1/admin/join-links/${created.id}/revoke`, {}, { ...JSON_TYPE, ...auth });
    assert.deepEqual(await rv.json(), { ok: true });
    assert.notEqual(((await (await app.request("/v1/admin/join-links", { headers: auth })).json()) as JoinLink[])[0]!.revokedAt, null);
    assert.equal((await post(app, "/v1/admin/join-links/jl_nope/revoke", {}, { ...JSON_TYPE, ...auth })).status, 404);
  });
});

test("creating a join link is refused for an admin-scope token, a member and an agent", async () => {
  await withApp(async ({ db, app }) => {
    const sam = await signIn(db, "sam", "admin");
    const ben = await signIn(db, "ben", "member");
    const bot = await agentAuth(db, "ben-agent");
    const refused: Record<string, string>[] = [
      { authorization: `Bearer ${await adminScopeToken(db, sam.actor.id)}` },
      { cookie: ben.cookie },
      { authorization: `Bearer ${bot.token}` },
    ];
    for (const headers of refused) {
      assert.equal((await post(app, "/v1/admin/join-links", {}, { ...JSON_TYPE, ...headers })).status, 403);
    }
    assert.equal((await db`select count(*)::int as n from join_links`)[0]!.n, 0);
  });
});

test("POST /v1/join creates a member, sets the session cookie and returns whoami", async () => {
  await withApp(async ({ db, app }) => {
    const { secret } = await createJoinLink(db, { createdBy: null });
    const res = await post(app, "/v1/join", { code: secret, name: "ben", email: "ben@example.com" });
    assert.equal(res.status, 201);
    const who = (await res.json()) as Whoami;
    assert.deepEqual([who.actor.name, who.actor.kind, who.scope, who.role], ["ben", "person", null, "member"]);
    const set = res.headers.get("set-cookie") ?? "";
    assert.match(set, /^teamkit_session=ts_/);
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Lax/i);
    assert.deepEqual(await (await app.request("/v1/whoami", { headers: { cookie: cookieOf(res) } })).json(), who);
  });
});

test("POST /v1/join maps each refusal to its code and status, and sets no cookie", async () => {
  await withApp(async ({ db, app }) => {
    const { secret } = await createJoinLink(db, { createdBy: null, domains: ["example.com"] });
    const join = (body: object) => post(app, "/v1/join", { code: secret, ...body });
    assert.equal((await join({ name: "ana", email: "ana@example.com" })).status, 201);
    const cases: [object, number, string][] = [
      [{ code: "jc_nope", name: "ben", email: "ben@example.com" }, 404, "join_link_invalid"],
      [{ name: "ben", email: "ben@example.org" }, 403, "email_domain_not_allowed"],
      [{ name: "ana", email: "ana2@example.com" }, 409, "name_taken"],
      [{ name: "ben", email: "ana@example.com" }, 409, "email_taken"],
      [{ name: "Ben Lee", email: "ben@example.com" }, 400, "invalid_input"],
    ];
    for (const [body, status, errCode] of cases) {
      const res = await join(body);
      assert.equal(res.status, status, errCode);
      assert.equal((await errorOf(res)).code, errCode);
      assert.equal(res.headers.get("set-cookie"), null, errCode);
    }
  });
});

test("POST /v1/join refuses anything but application/json and creates no one", async () => {
  await withApp(async ({ db, app }) => {
    const { secret } = await createJoinLink(db, { createdBy: null });
    const res = await post(app, "/v1/join", { code: secret, name: "ana", email: "ana@example.com" }, { "content-type": "text/plain" });
    assert.equal(res.status, 400);
    assert.deepEqual(await errorOf(res), { code: "invalid_input", message: "joining must send content-type: application/json" });
    assert.equal((await db`select count(*)::int as n from actors where name = 'ana'`)[0]!.n, 0);
  });
});

test("POST /v1/join allows a burst per client address, then answers 429 with Retry-After", async () => {
  await withApp(async ({ db, app }) => {
    const { secret } = await createJoinLink(db, { createdBy: null });
    const from = { incoming: { socket: { remoteAddress: "10.0.0.1" } } };
    const join = (name: string) => app.request("/v1/join",
      { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ code: secret, name, email: `${name}@example.com` }) }, from);
    assert.equal((await join("ana")).status, 201);
    assert.equal((await join("ben")).status, 201);
    const limited = await join("sam");
    assert.equal(limited.status, 429);
    assert.equal((await errorOf(limited)).code, "rate_limited");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  }, undefined, { joinLimit: { burst: 2, perMinute: 1 } });
});
