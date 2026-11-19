import { test } from "node:test";
import assert from "node:assert/strict";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { authenticate, can, createAgent } from "../src/store/actors.js";
import type { Db } from "../src/db/pool.js";
import { approveDevice, normalizeUserCode, pollDevice, startDevice } from "../src/store/device.js";

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("startDevice formats codes and stores only the hash", async () => {
  await withTestDb(async (db) => {
    const d = await startDevice(db);
    assert.match(d.deviceCode, /^dc_[A-Za-z0-9_-]{43}$/);
    assert.match(d.userCode, /^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/);
    assert.ok(Date.parse(d.expiresAt) > Date.now());
    const rows = await db`select code from device_codes`;
    assert.equal(rows[0]!.code, hashToken(d.deviceCode));
    assert.ok(!JSON.stringify(await db`select * from device_codes`).includes(d.deviceCode));
  });
});

test("poll is pending, then approved once with an admin-scope token, then expired", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada", "admin");
    const d = await startDevice(db);
    assert.deepEqual(await pollDevice(db, d.deviceCode), { status: "pending" });
    await approveDevice(db, ada, d.userCode.toLowerCase().replace("-", " "));
    await assert.rejects(approveDevice(db, ada, d.userCode), code("invalid_state"));
    const got = await pollDevice(db, d.deviceCode);
    assert.equal(got.status, "approved");
    if (got.status !== "approved") return;
    assert.equal(got.actor.name, "ada");
    const auth = await authenticate(db, got.token);
    assert.equal(auth?.scope, "admin");
    assert.equal(auth?.role, "admin");
    assert.equal(auth?.actor.id, ada.actor.id);
    assert.deepEqual(await pollDevice(db, d.deviceCode), { status: "expired" });
    assert.equal((await db`select count(*)::int as n from tokens where scope = 'admin'`)[0]!.n, 1);
    assert.ok(!JSON.stringify(await db`select * from tokens`).includes(got.token));
    await assert.rejects(approveDevice(db, ada, d.userCode), code("not_found"));
    await assert.rejects(pollDevice(db, "dc_unknown"), code("not_found"));
  });
});

test("only a signed-in person approves", async () => {
  await withTestDb(async (db) => {
    const bot = await agentAuth(db, "bot");
    const d = await startDevice(db);
    await assert.rejects(approveDevice(db, bot, d.userCode), code("forbidden"));
    const ada = await personAuth(db, "ada", "admin");
    await assert.rejects(approveDevice(db, { ...ada, via: "token" }, d.userCode), code("forbidden"));
    await assert.rejects(approveDevice(db, ada, "ABCD-EFGH"), code("invalid_input"));
    assert.deepEqual(await pollDevice(db, d.deviceCode), { status: "pending" });
  });
});

test("an expired code cannot be approved and polls as expired", async () => {
  const prev = process.env.TEAMKIT_DEVICE_TTL_MS;
  process.env.TEAMKIT_DEVICE_TTL_MS = "50";
  try {
    await withTestDb(async (db) => {
      const ada = await personAuth(db, "ada", "admin");
      const d = await startDevice(db);
      await sleep(100);
      assert.deepEqual(await pollDevice(db, d.deviceCode), { status: "expired" });
      await assert.rejects(approveDevice(db, ada, d.userCode), code("not_found"));
    });
  } finally {
    if (prev === undefined) delete process.env.TEAMKIT_DEVICE_TTL_MS;
    else process.env.TEAMKIT_DEVICE_TTL_MS = prev;
  }
});

test("concurrent polls of an approved code mint one token", async () => {
  await withTestDb(async (db) => {
    const ada = await personAuth(db, "ada", "admin");
    const d = await startDevice(db);
    await approveDevice(db, ada, d.userCode);
    const rs = await Promise.all([pollDevice(db, d.deviceCode), pollDevice(db, d.deviceCode)]);
    assert.deepEqual(rs.map((r) => r.status).sort(), ["approved", "expired"]);
  });
});

test("normalizeUserCode", () => {
  assert.equal(normalizeUserCode("bcdf ghjk"), "BCDF-GHJK");
  assert.equal(normalizeUserCode("ABCD-EFGH"), null);
  assert.equal(normalizeUserCode("BCDF-GHJ"), null);
});

test("an approved code expires uncollected: polling after its expiry mints no token", async () => {
  const prev = process.env.TEAMKIT_DEVICE_TTL_MS;
  process.env.TEAMKIT_DEVICE_TTL_MS = "300";
  try {
    await withTestDb(async (db) => {
      const ada = await personAuth(db, "ada", "admin");
      const d = await startDevice(db);
      await approveDevice(db, ada, d.userCode);
      await sleep(400);
      assert.deepEqual(await pollDevice(db, d.deviceCode), { status: "expired" });
      assert.equal((await db`select count(*)::int as n from tokens where scope = 'admin'`)[0]!.n, 0);
    });
  } finally {
    if (prev === undefined) delete process.env.TEAMKIT_DEVICE_TTL_MS;
    else process.env.TEAMKIT_DEVICE_TTL_MS = prev;
  }
});

test("starting a code deletes codes that expired over an hour ago and keeps recent ones", async () => {
  await withTestDb(async (db) => {
    await db`insert into device_codes (code, user_code, expires_at)
             values ('old', 'BBBB-BBBB', now() - interval '2 hours'),
                    ('recent', 'CCCC-CCCC', now() - interval '1 minute')`;
    const d = await startDevice(db);
    const codes = (await db`select code from device_codes order by code`).map((r) => r.code as string);
    assert.deepEqual(codes, [hashToken(d.deviceCode), "recent"].sort());
  });
});

const grantsOf = async (db: Db, name: string) =>
  (await db`select g.room_pattern, g.perms from grants g join actors a on a.id = g.actor_id where a.name = ${name} order by 1`)
    .map((r) => ({ room: r.room_pattern as string, perms: [...(r.perms as string[])].sort() }));
const ALL = ["claim", "create", "post", "read"];

test("agent mode: approving creates <person>-agent owned by the person, with the picked rooms, and polls an agent token", async () => {
  await withTestDb(async (db) => {
    const ana = await personAuth(db, "ana", "member");
    const d = await startDevice(db, "agent");
    assert.equal(d.mode, "agent");
    const out = await approveDevice(db, ana, d.userCode, ["billing-migration", "billing-migration"]);
    assert.equal(out.mode, "agent");
    assert.deepEqual([out.agent?.name, out.agent?.kind], ["ana-agent", "agent"]);
    const got = await pollDevice(db, d.deviceCode);
    assert.equal(got.status, "approved");
    if (got.status !== "approved") return;
    assert.deepEqual(got.actor, out.agent);
    const auth = await authenticate(db, got.token);
    assert.deepEqual([auth?.scope, auth?.role], ["agent", null]);
    assert.equal((await db`select owner_id from actors where name = 'ana-agent'`)[0]!.owner_id, ana.actor.id);
    assert.deepEqual(await grantsOf(db, "ana-agent"), [{ room: "billing-migration", perms: ALL }]);
    assert.equal(await can(db, got.actor, "billing-migration", "claim"), true);
    assert.equal(await can(db, got.actor, "billing-prod", "read"), false);
  });
});

// Review Focus 4
test("a second install reuses the agent with a new token; rooms add up and the first token keeps working", async () => {
  await withTestDb(async (db) => {
    const ana = await personAuth(db, "ana", "member");
    const tokenFor = async (rooms: string[]) => {
      const d = await startDevice(db, "agent");
      await approveDevice(db, ana, d.userCode, rooms);
      const got = await pollDevice(db, d.deviceCode);
      assert.equal(got.status, "approved");
      return got.status === "approved" ? got : assert.fail();
    };
    const first = await tokenFor(["billing-migration", "billing-prod"]);
    const second = await tokenFor(["billing-prod"]);
    assert.notEqual(first.token, second.token);
    assert.equal(first.actor.id, second.actor.id);
    assert.equal((await db`select count(*)::int as n from actors where name = 'ana-agent'`)[0]!.n, 1);
    assert.deepEqual((await grantsOf(db, "ana-agent")).map((g) => g.room), ["billing-migration", "billing-prod"]);
    assert.equal((await authenticate(db, first.token))?.actor.name, "ana-agent");
  });
});

// Review Focus 5
test("an admin-mode code approved with rooms is refused and mints nothing", async () => {
  await withTestDb(async (db) => {
    const sam = await personAuth(db, "sam", "admin");
    const d = await startDevice(db);
    await assert.rejects(approveDevice(db, sam, d.userCode, ["billing-prod"]), code("invalid_input"));
    assert.deepEqual(await pollDevice(db, d.deviceCode), { status: "pending" });
    assert.equal((await db`select count(*)::int as n from actors where name = 'sam-agent'`)[0]!.n, 0);
    assert.equal((await db`select count(*)::int as n from tokens`)[0]!.n, 0);
  });
});

test("an agent-mode code needs one to 50 valid rooms", async () => {
  await withTestDb(async (db) => {
    const ana = await personAuth(db, "ana", "member");
    const d = await startDevice(db, "agent");
    const many = Array.from({ length: 51 }, (_, i) => `room-${i}`);
    for (const rooms of [undefined, [], ["Billing Prod"], many]) {
      await assert.rejects(approveDevice(db, ana, d.userCode, rooms), code("invalid_input"), JSON.stringify(rooms));
    }
    assert.deepEqual(await pollDevice(db, d.deviceCode), { status: "pending" });
  });
});

test("<person>-agent owned by someone else is name_taken", async () => {
  await withTestDb(async (db) => {
    await createAgent(db, { name: "ben-agent", grants: [] });
    const ben = await personAuth(db, "ben", "member");
    const d = await startDevice(db, "agent");
    await assert.rejects(approveDevice(db, ben, d.userCode, ["billing-migration"]), code("name_taken"));
    assert.deepEqual(await pollDevice(db, d.deviceCode), { status: "pending" });
  });
});

test("two agent-mode approvals at once for one person make one agent and two tokens", async () => {
  await withTestDb(async (db) => {
    const ana = await personAuth(db, "ana", "member");
    const [a, b] = [await startDevice(db, "agent"), await startDevice(db, "agent")];
    await Promise.all([approveDevice(db, ana, a.userCode, ["billing-migration"]), approveDevice(db, ana, b.userCode, ["billing-prod"])]);
    const [pa, pb] = [await pollDevice(db, a.deviceCode), await pollDevice(db, b.deviceCode)];
    assert.ok(pa.status === "approved" && pb.status === "approved" && pa.actor.id === pb.actor.id && pa.token !== pb.token);
    assert.equal((await db`select count(*)::int as n from actors where name = 'ana-agent'`)[0]!.n, 1);
  });
});

test("a poll that waits on an agent-mode approval sees the agent the approval created", async () => {
  await withTestDb(async (db) => {
    const ana = await personAuth(db, "ana", "member");
    const d = await startDevice(db, "agent");
    // Do what an agent-mode approval writes, holding the code's row lock while the poll starts.
    let polling!: ReturnType<typeof pollDevice>;
    await db.begin(async (tx) => {
      await tx`select 1 from device_codes where user_code = ${d.userCode} for update`;
      await tx`insert into actors (id, kind, name, owner_id) values ('ac_race', 'agent', 'ana-agent', ${ana.actor.id})`;
      await tx`update device_codes set actor_id = 'ac_race', approved_at = now() where user_code = ${d.userCode}`;
      polling = pollDevice(db, d.deviceCode);
      await sleep(200);
    });
    const got = await polling;
    assert.equal(got.status, "approved");
    if (got.status === "approved") assert.deepEqual(got.actor, { id: "ac_race", name: "ana-agent", kind: "agent" });
  });
});
