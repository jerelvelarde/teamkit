import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db/pool.js";
import { withTestDb } from "./helpers/db.js";
import { createAgent } from "../src/store/actors.js";
import { authenticateSession } from "../src/store/people.js";
import { createJoinLink, joinUrl, listJoinLinks, redeemJoinLink, revokeJoinLink } from "../src/store/join.js";

const code = (c: string, msg?: RegExp) => (e: unknown) =>
  (e as { code?: string }).code === c && (msg === undefined || msg.test((e as Error).message));
const uses = async (db: Db) => (await listJoinLinks(db))[0]!.uses;

test("createJoinLink stores only the hash and lists the link without its secret", async () => {
  await withTestDb(async (db) => {
    const { joinLink, secret } = await createJoinLink(db, { createdBy: null, expiresInDays: 7, domains: ["@Example.com", "example.com"] });
    assert.match(secret, /^jc_[A-Za-z0-9_-]{43}$/);
    assert.match(joinLink.id, /^jl_[0-9a-f]{16}$/);
    assert.deepEqual(joinLink.domains, ["example.com"]);
    assert.equal(joinLink.uses, 0);
    assert.equal(joinLink.revokedAt, null);
    assert.ok(Math.abs((Date.parse(joinLink.expiresAt!) - Date.parse(joinLink.createdAt)) / 86_400_000 - 7) < 0.001);
    assert.ok(!JSON.stringify(await db`select * from join_links`).includes(secret));
    assert.deepEqual(await listJoinLinks(db), [joinLink]);
    assert.equal(joinUrl("https://teamkit.example.com/", secret), `https://teamkit.example.com/join/${secret}`);
  });
});

test("createJoinLink defaults to no expiry and no domain limit, and refuses bad input", async () => {
  await withTestDb(async (db) => {
    const open = (await createJoinLink(db, { createdBy: null })).joinLink;
    assert.equal(open.expiresAt, null);
    assert.equal(open.domains, null);
    assert.equal((await createJoinLink(db, { createdBy: null, domains: [] })).joinLink.domains, null);
    for (const days of [0, 366, 1.5, Number.NaN]) {
      await assert.rejects(createJoinLink(db, { createdBy: null, expiresInDays: days }), code("invalid_input", /1 to 365/));
    }
    await assert.rejects(createJoinLink(db, { createdBy: null, domains: ["example"] }), code("invalid_input", /not a domain: example/));
    const many = Array.from({ length: 21 }, (_, i) => `d${i}.example.com`);
    await assert.rejects(createJoinLink(db, { createdBy: null, domains: many }), code("invalid_input", /at most 20/));
  });
});

test("redeemJoinLink creates a member with an email and a session, and counts the use", async () => {
  await withTestDb(async (db) => {
    const { secret } = await createJoinLink(db, { createdBy: null });
    const s = await redeemJoinLink(db, { code: secret, name: "ana", email: "ana@example.com" });
    assert.equal(s.actor.name, "ana");
    assert.equal(s.actor.kind, "person");
    assert.equal(s.role, "member");
    assert.deepEqual(await authenticateSession(db, s.sessionSecret), { actor: s.actor, role: "member" });
    assert.equal((await db`select email from actors where id = ${s.actor.id}`)[0]!.email, "ana@example.com");
    assert.equal(await uses(db), 1);
  });
});

test("a revoked, expired or unknown join link is join_link_invalid", async () => {
  await withTestDb(async (db) => {
    const a = await createJoinLink(db, { createdBy: null });
    await revokeJoinLink(db, a.joinLink.id);
    const first = (await listJoinLinks(db))[0]!.revokedAt;
    await revokeJoinLink(db, a.joinLink.id);
    assert.equal((await listJoinLinks(db))[0]!.revokedAt, first);
    await assert.rejects(redeemJoinLink(db, { code: a.secret, name: "ana", email: "ana@example.com" }),
      code("join_link_invalid", /^this join link is invalid, revoked or expired$/));
    const b = await createJoinLink(db, { createdBy: null, expiresInDays: 1 });
    await db`update join_links set expires_at = clock_timestamp() - interval '1 second' where id = ${b.joinLink.id}`;
    await assert.rejects(redeemJoinLink(db, { code: b.secret, name: "ana", email: "ana@example.com" }), code("join_link_invalid"));
    for (const bad of ["jc_nope", ""]) {
      await assert.rejects(redeemJoinLink(db, { code: bad, name: "ana", email: "ana@example.com" }), code("join_link_invalid"));
    }
    await assert.rejects(revokeJoinLink(db, "jl_nope"), code("not_found"));
  });
});

// Review Focus 3
test("domains match exactly, ignoring case: subdomains are refused", async () => {
  await withTestDb(async (db) => {
    const { secret } = await createJoinLink(db, { createdBy: null, domains: ["example.com"] });
    const ana = await redeemJoinLink(db, { code: secret, name: "ana", email: "Ana@Example.COM" });
    assert.equal((await db`select email from actors where id = ${ana.actor.id}`)[0]!.email, "ana@example.com");
    for (const email of ["ben@eu.example.com", "ben@example.org"]) {
      await assert.rejects(redeemJoinLink(db, { code: secret, name: "ben", email }),
        code("email_domain_not_allowed", /^this join link only accepts emails at example\.com$/));
    }
  });
});

// Review Focus 1
test("names are trimmed and lower-cased; a name an agent name cannot carry is invalid_input", async () => {
  await withTestDb(async (db) => {
    const { secret } = await createJoinLink(db, { createdBy: null });
    assert.equal((await redeemJoinLink(db, { code: secret, name: " Ana ", email: "ana@example.com" })).actor.name, "ana");
    for (const name of ["Ana Lopez", "a".repeat(58)]) {
      await assert.rejects(redeemJoinLink(db, { code: secret, name, email: "ben@example.com" }),
        code("invalid_input", /lowercase letters, digits and hyphens, up to 57 characters/));
    }
    await assert.rejects(redeemJoinLink(db, { code: secret, name: "ben", email: "ben" }), code("invalid_input", /not an email address/));
    // A person named ben-agent would take ben's agent name before ben's agent exists.
    for (const name of ["ben-agent", " Ben-Agent "]) {
      await assert.rejects(redeemJoinLink(db, { code: secret, name, email: "ben@example.com" }), code("invalid_input", /-agent/));
    }
  });
});

// Review Focus 2
test("a taken name, a taken <name>-agent or a taken email is refused, and a refused join counts no use", async () => {
  await withTestDb(async (db) => {
    const { secret } = await createJoinLink(db, { createdBy: null });
    await redeemJoinLink(db, { code: secret, name: "ana", email: "ana@example.com" });
    await assert.rejects(redeemJoinLink(db, { code: secret, name: "ana", email: "other@example.com" }),
      code("name_taken", /^the name ana is taken$/));
    await createAgent(db, { name: "ben-agent", grants: [] });
    await assert.rejects(redeemJoinLink(db, { code: secret, name: "ben", email: "ben@example.com" }),
      code("name_taken", /ben-agent is already in use/));
    await assert.rejects(redeemJoinLink(db, { code: secret, name: "sam", email: "ana@example.com" }), code("email_taken"));
    assert.equal(await uses(db), 1);
  });
});

test("two joins with one name at once: one person, one name_taken", async () => {
  await withTestDb(async (db) => {
    const { secret } = await createJoinLink(db, { createdBy: null });
    const rs = await Promise.allSettled([
      redeemJoinLink(db, { code: secret, name: "ana", email: "ana@example.com" }),
      redeemJoinLink(db, { code: secret, name: "ana", email: "ana2@example.com" }),
    ]);
    assert.deepEqual(rs.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.ok(code("name_taken")((rs.find((r) => r.status === "rejected") as PromiseRejectedResult).reason));
    assert.equal(await uses(db), 1);
  });
});
