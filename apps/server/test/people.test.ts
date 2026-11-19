import { test } from "node:test";
import assert from "node:assert/strict";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import { withTestDb } from "./helpers/db.js";
import { createAgent } from "../src/store/actors.js";
import {
  authenticateSession,
  consumeSignInLink,
  createSignInLink,
  emailSignInLink,
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

test("ensureBootstrapLink issues links until someone signs in; only the latest works", async () => {
  await withTestDb(async (db) => {
    const boots = [await ensureBootstrapLink(db), await ensureBootstrapLink(db), await ensureBootstrapLink(db)];
    assert.ok(boots.every((l) => l !== null));
    assert.equal(new Set(boots).size, 3);
    const [first, second, last] = boots as string[];
    await assert.rejects(consumeSignInLink(db, first!), code("unauthorized"));
    await assert.rejects(consumeSignInLink(db, second!), code("unauthorized"));
    const s = await consumeSignInLink(db, last!);
    assert.equal(s.role, "admin");
    assert.equal(s.actor.name, "admin");
    assert.equal(await ensureBootstrapLink(db), null);
    for (const l of boots) await assert.rejects(consumeSignInLink(db, l!), code("unauthorized"));
  });
});

test("signing in cancels the person's other links, and no one else's", async () => {
  await withTestDb(async (db) => {
    const boot = (await ensureBootstrapLink(db))!;
    const ana = await invitePerson(db, { name: "ana", role: "member" });
    const again = await createSignInLink(db, ana.person.id);
    const bob = await invitePerson(db, { name: "bob", role: "member" });
    assert.equal((await consumeSignInLink(db, again)).actor.name, "ana");
    await assert.rejects(consumeSignInLink(db, ana.secret), code("unauthorized"));
    assert.equal((await consumeSignInLink(db, bob.secret)).actor.name, "bob");
    assert.equal((await consumeSignInLink(db, boot)).actor.name, "admin");
  });
});

test("two links of one person used at once: one signs in, the other is refused", async () => {
  await withTestDb(async (db) => {
    const ana = await invitePerson(db, { name: "ana", role: "member" });
    const links = [ana.secret, ...(await Promise.all([1, 2, 3].map(() => createSignInLink(db, ana.person.id))))];
    const results = await Promise.allSettled(links.map((l) => consumeSignInLink(db, l)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results) {
      if (r.status === "rejected") assert.equal((r.reason as { code?: string }).code, "unauthorized");
    }
    assert.equal((await db`select 1 from sessions`).length, 1);
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

test("an invite can carry an email, lower-cased and unique, so email sign-in finds the person", async () => {
  await withTestDb(async (db) => {
    const ben = await invitePerson(db, { name: "ben", role: "member", email: " Ben@Example.com " });
    assert.equal((await db`select email from actors where id = ${ben.person.id}`)[0]!.email, "ben@example.com");
    assert.equal((await emailSignInLink(db, "ben@example.com"))?.person.name, "ben");
    await assert.rejects(invitePerson(db, { name: "sam", role: "member", email: "ben@example.com" }), code("email_taken"));
    await assert.rejects(invitePerson(db, { name: "sam", role: "member", email: "sam" }), code("invalid_input"));
    assert.equal((await db`select count(*)::int as n from actors where name = 'sam'`)[0]!.n, 0);
    await invitePerson(db, { name: "ana", role: "admin" });
    await invitePerson(db, { name: "ana", role: "admin", email: "ana@example.com" });
    assert.equal((await db`select email from actors where name = 'ana'`)[0]!.email, "ana@example.com");
  });
});
