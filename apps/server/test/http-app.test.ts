import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "./helpers/db.js";
import { agentAuth } from "./helpers/actors.js";
import { createNotifier } from "../src/notifier.js";
import { createApp } from "../src/http/app.js";

async function withApp(
  fn: (app: ReturnType<typeof createApp>, token: string) => Promise<void>,
): Promise<void> {
  await withTestDb(async (db) => {
    const notifier = await createNotifier(db);
    try {
      const a = await agentAuth(db, "bot");
      await fn(createApp({ db, notifier }), a.token);
    } finally {
      await notifier.close();
    }
  });
}

test("no token is 401 with the error body", async () => {
  await withApp(async (app) => {
    const res = await app.request("/v1/whoami");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      error: { code: "unauthorized", message: "missing bearer token" },
    });
  });
});

test("a bad token is 401", async () => {
  await withApp(async (app) => {
    const res = await app.request("/v1/whoami", { headers: { authorization: "Bearer tk_nope" } });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unauthorized");
  });
});

test("/v1/whoami returns the agent", async () => {
  await withApp(async (app, token) => {
    const res = await app.request("/v1/whoami", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { actor: { name: string }; scope: string };
    assert.equal(body.actor.name, "bot");
    assert.equal(body.scope, "agent");
  });
});

test("an unknown /v1 path is 404 not_found", async () => {
  await withApp(async (app, token) => {
    const res = await app.request("/v1/nope", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: { code: "not_found", message: "no such route" } });
  });
});

test("a 1.1 MB body is 413 too_large", async () => {
  await withApp(async (app, token) => {
    const body = "x".repeat(1_100_000);
    const res = await app.request("/v1/whoami", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-length": String(body.length) },
      body,
    });
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "too_large");
  });
});

test("/healthz is 200 without auth", async () => {
  await withApp(async (app) => {
    const res = await app.request("/healthz");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
