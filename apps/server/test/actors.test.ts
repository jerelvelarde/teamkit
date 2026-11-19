import { test } from "node:test";
import assert from "node:assert/strict";
import { hashToken } from "@copilotkit/teamkit-protocol";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import {
  authenticate,
  can,
  createAgent,
  createAgentTokens,
  createPerson,
  listTokens,
  requirePerm,
  revokeToken,
} from "../src/store/actors.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

test("a token authenticates; a revoked one does not", async () => {
  await withTestDb(async (db) => {
    const a = await createAgent(db, { name: "bot", grants: [{ room: "*", perms: ["read"] }] });
    const auth = await authenticate(db, a.token);
    assert.equal(auth?.actor.id, a.actor.id);
    assert.equal(auth?.scope, "agent");
    assert.equal(auth?.role, null);
    assert.equal(await authenticate(db, "tk_nope"), null);
    assert.equal(await authenticate(db, ""), null);
    await revokeToken(db, a.tokenId);
    assert.equal(await authenticate(db, a.token), null);
    await assert.rejects(revokeToken(db, "tok_missing"), code("not_found"));
  });
});

test("only the sha256 hash of the token is stored", async () => {
  await withTestDb(async (db) => {
    const a = await createAgent(db, { name: "bot", grants: [] });
    const rows = await db`select hash from tokens where id = ${a.tokenId}`;
    assert.equal(rows[0]!.hash, hashToken(a.token));
    const dump = JSON.stringify(await db`select * from tokens`);
    assert.ok(!dump.includes(a.token));
    const list = await listTokens(db);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.actorName, "bot");
    assert.equal(list[0]!.revokedAt, null);
    assert.ok(!JSON.stringify(list).includes(a.token));
    await revokeToken(db, a.tokenId);
    assert.ok((await listTokens(db))[0]!.revokedAt);
  });
});

test("grant build/:[read] can read build/x and build, not post, not other rooms", async () => {
  await withTestDb(async (db) => {
    const a = await createAgent(db, { name: "bot", grants: [{ room: "build/", perms: ["read"] }] });
    assert.equal(await can(db, a.actor, "build/x", "read"), true);
    assert.equal(await can(db, a.actor, "build", "read"), true);
    assert.equal(await can(db, a.actor, "build/x", "post"), false);
    assert.equal(await can(db, a.actor, "builder", "read"), false);
  });
});

test("createAgentTokens names worker-1..3 in one transaction", async () => {
  await withTestDb(async (db) => {
    const r = await createAgentTokens(db, {
      baseName: "worker",
      count: 3,
      grants: [{ room: "*", perms: ["claim"] }],
    });
    assert.deepEqual(r.map((x) => x.actor.name), ["worker-1", "worker-2", "worker-3"]);
    assert.equal(new Set(r.map((x) => x.token)).size, 3);
    // a collision rolls everything back
    await createAgent(db, { name: "dup-2", grants: [] });
    await assert.rejects(createAgentTokens(db, { baseName: "dup", count: 3, grants: [] }), code("invalid_input"));
    const rows = await db`select name from actors where name like 'dup-%'`;
    assert.equal(rows.length, 1);
    for (const count of [0, 101, 1.5]) {
      await assert.rejects(createAgentTokens(db, { baseName: "x", count, grants: [] }), code("invalid_input"));
    }
  });
});

test("invalid input is rejected", async () => {
  await withTestDb(async (db) => {
    for (const name of ["Bad", "-x", "a b", "", "a".repeat(64)]) {
      await assert.rejects(createAgent(db, { name, grants: [] }), code("invalid_input"));
      await assert.rejects(createPerson(db, { name, role: "member" }), code("invalid_input"));
    }
    await createAgent(db, { name: "bot", grants: [] });
    await assert.rejects(createAgent(db, { name: "bot", grants: [] }), code("invalid_input"));
    await assert.rejects(createPerson(db, { name: "bot", role: "member" }), code("invalid_input"));
    await assert.rejects(
      createAgent(db, { name: "b2", grants: [{ room: "Bad Room", perms: ["read"] }] }),
      code("invalid_input"),
    );
    await assert.rejects(
      createAgent(db, { name: "b3", grants: [{ room: "*", perms: ["nuke" as never] }] }),
      code("invalid_input"),
    );
    assert.equal((await db`select 1 from actors where name in ('b2','b3')`).length, 0);
  });
});

test("duplicate grant patterns merge", async () => {
  await withTestDb(async (db) => {
    const a = await createAgent(db, {
      name: "bot",
      grants: [
        { room: "x", perms: ["read"] },
        { room: "x", perms: ["post"] },
      ],
    });
    assert.equal(await can(db, a.actor, "x", "read"), true);
    assert.equal(await can(db, a.actor, "x", "post"), true);
  });
});

test("requirePerm throws forbidden for agents lacking the perm", async () => {
  await withTestDb(async (db) => {
    const a = await agentAuth(db, "bot", [{ room: "build/", perms: ["read"] }]);
    await requirePerm(db, a, "build/x", "read");
    await assert.rejects(requirePerm(db, a, "build/x", "post"), (e) => {
      assert.ok(code("forbidden")(e));
      assert.equal((e as Error).message, "bot lacks post in build/x");
      return true;
    });
    assert.equal(a.via, "token");
    assert.equal(a.scope, "agent");
  });
});

test("a person can do everything", async () => {
  await withTestDb(async (db) => {
    const p = await personAuth(db, "ann");
    assert.equal(p.via, "session");
    assert.equal(p.scope, null);
    for (const perm of ["read", "post", "claim", "create"] as const) {
      assert.equal(await can(db, p.actor, "any/room", perm), true);
      await requirePerm(db, p, "any/room", perm);
    }
  });
});

test("an agent with an owner records owner_id", async () => {
  await withTestDb(async (db) => {
    const p = await createPerson(db, { name: "ann", role: "admin" });
    const a = await createAgent(db, { name: "bot", ownerId: p.id, grants: [] });
    const [r] = await db`select owner_id from actors where id = ${a.actor.id}`;
    assert.equal(r!.owner_id, p.id);
    await assert.rejects(createAgent(db, { name: "b2", ownerId: "ac_nope", grants: [] }), code("invalid_input"));
  });
});
