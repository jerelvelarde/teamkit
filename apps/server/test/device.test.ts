import { test } from "node:test";
import assert from "node:assert/strict";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { authenticate } from "../src/store/actors.js";
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
