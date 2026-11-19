import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../../../apps/server/test/helpers/server.js";
import { personAuth } from "../../../apps/server/test/helpers/actors.js";
import type { Db } from "../../../apps/server/src/db/pool.js";
import { approveDevice, pollDevice, startDevice } from "../../../apps/server/src/store/device.js";
import { consumeSignInLink, invitePerson } from "../../../apps/server/src/store/people.js";
import { createClient, TeamkitError } from "../src/client.js";
import { createAdminClient } from "../src/admin.js";

/** An admin-scope token for a person, the way `teamkit login` gets one. */
async function adminToken(db: Db, name: string, role: "admin" | "member"): Promise<string> {
  const person = await personAuth(db, name, role);
  const d = await startDevice(db);
  await approveDevice(db, person, d.userCode);
  const polled = await pollDevice(db, d.deviceCode);
  assert.equal(polled.status, "approved");
  return (polled as { token: string }).token;
}

async function expectForbidden(p: Promise<unknown>): Promise<void> {
  await assert.rejects(p, (e) => e instanceof TeamkitError && e.code === "forbidden" && e.status === 403);
}

test("admin client: tokens, rooms, people and logout with an admin-scope token", async () => {
  const srv = await startTestServer();
  try {
    const token = await adminToken(srv.db, "ada", "admin");
    const admin = createAdminClient({ url: srv.url, token });

    const who = await admin.whoami();
    assert.equal(who.actor.name, "ada");
    assert.equal(who.scope, "admin");

    const created = await admin.createTokens({
      name: "worker",
      rooms: [{ room: "build", perms: ["read", "post", "claim"] }],
      count: 2,
    });
    assert.equal(created.length, 2);
    for (const t of created) {
      const me = await createClient({ url: srv.url, token: t.token }).whoami();
      assert.equal(me.actor.name, t.actor.name);
    }

    const listed = await admin.tokens();
    for (const t of created) assert.ok(listed.some((x) => x.id === t.tokenId && x.revokedAt === null));

    const first = created[0]!;
    await admin.revokeToken(first.tokenId);
    const after = await admin.tokens();
    assert.notEqual(after.find((x) => x.id === first.tokenId)?.revokedAt ?? null, null);
    await assert.rejects(createClient({ url: srv.url, token: first.token }).whoami(), TeamkitError);

    const room = await admin.setRoom("build", { approvers: ["ada"] });
    assert.deepEqual(room.approvers, ["ada"]);
    assert.ok((await admin.rooms()).some((r) => r.name === "build"));

    assert.ok((await admin.people()).some((p) => p.actor.name === "ada"));

    await admin.logout();
    await assert.rejects(admin.whoami(), (e) => e instanceof TeamkitError && e.status === 401);
  } finally {
    await srv.stop();
  }
});

test("admin client: a member's admin-scope token is forbidden", async () => {
  const srv = await startTestServer();
  try {
    const admin = createAdminClient({ url: srv.url, token: await adminToken(srv.db, "mia", "member") });
    await expectForbidden(admin.tokens());
    await expectForbidden(admin.people());
    await expectForbidden(admin.rooms());
  } finally {
    await srv.stop();
  }
});

test("admin client: invite and sign-in link refuse an admin-scope token, work with a session cookie", async () => {
  const srv = await startTestServer();
  try {
    const admin = createAdminClient({ url: srv.url, token: await adminToken(srv.db, "ada", "admin") });
    await expectForbidden(admin.invitePerson({ name: "eve" }));
    await expectForbidden(admin.personLink("ada"));
    const [eve] = await srv.db`select id from actors where name = 'eve'`;
    assert.equal(eve, undefined);

    // Cookie mode: an admin signed in on the web board (no token, session cookie via fetch).
    const inv = await invitePerson(srv.db, { name: "grace", role: "admin" });
    const session = await consumeSignInLink(srv.db, inv.secret);
    const cookieFetch: typeof fetch = (url, init) =>
      fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie: `teamkit_session=${session.sessionSecret}` } });
    const board = createAdminClient({ url: srv.url, fetch: cookieFetch });

    const invite = await board.invitePerson({ name: "bob" });
    assert.equal(invite.person.name, "bob");
    assert.equal(invite.role, "member");
    assert.match(invite.link, /\/signin\/sl_/);
    const { link } = await board.personLink("bob");
    assert.match(link, /\/signin\/sl_/);
  } finally {
    await srv.stop();
  }
});
