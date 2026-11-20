import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../../../apps/server/test/helpers/server.js";
import { personAuth } from "../../../apps/server/test/helpers/actors.js";
import { approveDevice } from "../../../apps/server/src/store/device.js";
import { TeamkitError, createClient } from "../src/client.js";
import { pollDeviceLogin, startDeviceLogin, waitForDeviceLogin } from "../src/device.js";

const CODE = /^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/;
const fast = (_ms: number) => new Promise<void>((r) => setTimeout(r, 10));

test("start returns a user code and a verify url", async () => {
  const srv = await startTestServer();
  try {
    const start = await startDeviceLogin(srv.url);
    assert.match(start.userCode, CODE);
    assert.ok(start.verifyUrl.endsWith(`/device?code=${start.userCode}`));
    assert.deepEqual(await pollDeviceLogin(srv.url, start.deviceCode), { status: "pending" });
  } finally {
    await srv.stop();
  }
});

test("wait resolves with the token and actor once a person approves", async () => {
  const srv = await startTestServer();
  try {
    const ada = await personAuth(srv.db, "ada", "admin");
    const start = await startDeviceLogin(srv.url + "/");
    const waiting = waitForDeviceLogin(srv.url, start, { sleep: fast });
    await new Promise((r) => setTimeout(r, 50));
    await approveDevice(srv.db, ada, start.userCode);
    const out = await waiting;
    assert.match(out.token, /^tk_/);
    assert.equal(out.actor.name, "ada");
    assert.equal(out.actor.id, ada.actor.id);
  } finally {
    await srv.stop();
  }
});

test("wait rejects with expired when nobody approves in time", async () => {
  const prev = process.env.TEAMKIT_DEVICE_TTL_MS;
  process.env.TEAMKIT_DEVICE_TTL_MS = "50";
  const srv = await startTestServer();
  try {
    const start = await startDeviceLogin(srv.url);
    await assert.rejects(waitForDeviceLogin(srv.url, start, { sleep: fast }), (e) => {
      assert.ok(e instanceof TeamkitError);
      assert.equal(e.code, "expired");
      assert.equal(e.status, 410);
      return true;
    });
  } finally {
    if (prev === undefined) delete process.env.TEAMKIT_DEVICE_TTL_MS;
    else process.env.TEAMKIT_DEVICE_TTL_MS = prev;
    await srv.stop();
  }
});

test("wait rejects with aborted when the signal fires", async () => {
  const srv = await startTestServer();
  try {
    const start = await startDeviceLogin(srv.url);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(waitForDeviceLogin(srv.url, start, { signal: ctl.signal }), (e) => {
      assert.ok(e instanceof TeamkitError);
      assert.equal(e.code, "aborted");
      return true;
    });
  } finally {
    await srv.stop();
  }
});

test("an unknown device code is not_found", async () => {
  const srv = await startTestServer();
  try {
    await assert.rejects(pollDeviceLogin(srv.url, "dc_nope"), (e) => {
      assert.ok(e instanceof TeamkitError);
      assert.equal(e.code, "not_found");
      return true;
    });
  } finally {
    await srv.stop();
  }
});

test("agent mode: start, approve with rooms, and wait resolves with <person>-agent", async () => {
  const srv = await startTestServer();
  try {
    const ana = await personAuth(srv.db, "ana", "member");
    const start = await startDeviceLogin(srv.url, { mode: "agent" });
    assert.ok(start.verifyUrl.endsWith(`/device?code=${start.userCode}&mode=agent`));
    const waiting = waitForDeviceLogin(srv.url, start, { sleep: fast });
    await approveDevice(srv.db, ana, start.userCode, ["billing-migration"]);
    const out = await waiting;
    assert.deepEqual([out.actor.name, out.actor.kind], ["ana-agent", "agent"]);
    assert.equal((await createClient({ url: srv.url, token: out.token }).whoami()).scope, "agent");
  } finally {
    await srv.stop();
  }
});

test("agent mode with an app: the verify url names the app, and wait resolves with <person>-<app>", async () => {
  const srv = await startTestServer();
  try {
    const ana = await personAuth(srv.db, "ana", "member");
    const start = await startDeviceLogin(srv.url, { mode: "agent", app: "codex" });
    assert.ok(start.verifyUrl.endsWith(`/device?code=${start.userCode}&mode=agent&app=codex`), start.verifyUrl);
    const waiting = waitForDeviceLogin(srv.url, start, { sleep: fast });
    await approveDevice(srv.db, ana, start.userCode, ["billing-migration"]);
    assert.deepEqual((await waiting).actor.name, "ana-codex");
  } finally {
    await srv.stop();
  }
});
