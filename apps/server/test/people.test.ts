import { test } from "node:test";
import assert from "node:assert/strict";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import { withTestDb } from "./helpers/db.js";
import { createAgent } from "../src/store/actors.js";
import {
  authenticateSession,
  consumeSignInLink,
  createSignInLink,
  ensureBootstrapLink,
  invitePerson,
  listPeople,
  revokeAdminToken,
  revokeSession,
  signInUrl,
} from "../src/store/people.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("invite, consume and authenticate a session", async () => {
  await withTestDb(async (db) => {
    const inv = await invitePerson(db, { name: "ana", role: "member" });
    assert.match(inv.secret, /^sl_[A-Za-z0-9_-]{43}$/);
    assert.equal(signInUrl("http://x.test/", inv.secret), `http://x.test/signin/${inv.secret}`);
    const s = await consumeSignInLink(db, inv.secret);
    assert.match(s.sessionSecret, /^ts_[A-Za-z0-9_-]{43}$/);
    assert.equal(s.actor.name, "ana");
    const auth = await authenticateSession(db, s.sessionSecret);
    assert.equal(auth?.actor.id, inv.person.id);
    assert.equal(auth?.role, "member");
    assert.equal(await authenticateSession(db, "ts_nope"), null);
    assert.equal(await revokeSession(db, s.sessionSecret), true);
    assert.equal(await authenticateSession(db, s.sessionSecret), null);
    assert.equal(await revokeSession(db, s.sessionSecret), false);
  });
});

test("only hashes of link and session secrets are stored", async () => {
  await withTestDb(async (db) => {
    const inv = await invitePerson(db, { name: "ana", role: "member" });
    const s = await consumeSignInLink(db, inv.secret);
    const dump = JSON.stringify([await db`select * from signin_links`, await db`select * from sessions`]);
    assert.ok(!dump.includes(inv.secret));
    assert.ok(!dump.includes(s.sessionSecret));
    assert.ok(dump.includes(hashToken(inv.secret)));
    assert.ok(dump.includes(hashToken(s.sessionSecret)));
  });
});

test("a link is single-use and expires", async () => {
  await withTestDb(async (db) => {
    const inv = await invitePerson(db, { name: "ana", role: "member" });
    await consumeSignInLink(db, inv.secret);
    await assert.rejects(consumeSignInLink(db, inv.secret), code("unauthorized"));
    const short = await createSignInLink(db, inv.person.id, 1);
    await sleep(20);
    await assert.rejects(consumeSignInLink(db, short), code("unauthorized"));
    await assert.rejects(consumeSignInLink(db, "sl_unknown"), code("unauthorized"));
  });
});

test("an expired session does not authenticate", async () => {
  await withTestDb(async (db) => {
    const inv = await invitePerson(db, { name: "ana", role: "member" });
    const s = await consumeSignInLink(db, inv.secret);
    await db`update sessions set expires_at = now() - interval '1 second'`;
    assert.equal(await authenticateSession(db, s.sessionSecret), null);
  });
});

test("inviting an agent's name fails; re-inviting a person keeps the role", async () => {
  await withTestDb(async (db) => {
    await createAgent(db, { name: "bot", grants: [] });
    await assert.rejects(invitePerson(db, { name: "bot", role: "member" }), code("invalid_input"));
    const a = await invitePerson(db, { name: "ana", role: "admin" });
    const b = await invitePerson(db, { name: "ana", role: "member" });
    assert.notEqual(a.secret, b.secret);
    assert.equal(b.role, "admin");
    assert.equal(b.person.id, a.person.id);
  });
});

test("listPeople shows lastSignInAt", async () => {
  await withTestDb(async (db) => {
    const inv = await invitePerson(db, { name: "ana", role: "member" });
    await invitePerson(db, { name: "bob", role: "member" });
    await createAgent(db, { name: "bot", grants: [] });
    let people = await listPeople(db);
    assert.deepEqual(people.map((p) => p.actor.name), ["ana", "bob"]);
    assert.equal(people[0]!.lastSignInAt, null);
    await consumeSignInLink(db, inv.secret);
    people = await listPeople(db);
    assert.ok(people[0]!.lastSignInAt);
    assert.equal(people[1]!.lastSignInAt, null);
  });
});

test("ensureBootstrapLink issues links until someone signs in", async () => {
  await withTestDb(async (db) => {
    const a = await ensureBootstrapLink(db);
    const b = await ensureBootstrapLink(db);
    assert.ok(a && b);
    assert.notEqual(a, b);
    const s = await consumeSignInLink(db, a);
    assert.equal(s.role, "admin");
    assert.equal(s.actor.name, "admin");
    assert.equal(await ensureBootstrapLink(db), null);
  });
});

test("bootstrap avoids an agent named admin", async () => {
  await withTestDb(async (db) => {
    await createAgent(db, { name: "admin", grants: [] });
    const a = await ensureBootstrapLink(db);
    assert.equal((await consumeSignInLink(db, a!)).actor.name, "teamkit-admin");
  });
});

test("revokeAdminToken only revokes admin-scope tokens", async () => {
  await withTestDb(async (db) => {
    const agent = await createAgent(db, { name: "bot", grants: [] });
    assert.equal(await revokeAdminToken(db, agent.token), false);
    const inv = await invitePerson(db, { name: "ana", role: "admin" });
    const secret = "tk_admin-test-secret";
    await db`insert into tokens (id, actor_id, hash, scope) values ('tok_adm1', ${inv.person.id}, ${hashToken(secret)}, 'admin')`;
    assert.equal(await revokeAdminToken(db, secret), true);
    assert.equal(await revokeAdminToken(db, secret), false);
    const [t] = await db`select revoked_at from tokens where id = ${agent.tokenId}`;
    assert.equal(t!.revoked_at, null);
  });
});

test("a new sign-in link deletes expired links and keeps live ones", async () => {
  await withTestDb(async (db) => {
    const inv = await invitePerson(db, { name: "ana", role: "member" });
    const short = await createSignInLink(db, inv.person.id, 1);
    await sleep(20);
    const fresh = await createSignInLink(db, inv.person.id);
    const hashes = (await db`select hash from signin_links`).map((r) => r.hash as string).sort();
    assert.deepEqual(hashes, [hashToken(inv.secret), hashToken(fresh)].sort());
    assert.ok(!hashes.includes(hashToken(short)));
  });
});
