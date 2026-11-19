import { test } from "node:test";
import assert from "node:assert/strict";
import { agentToken, startTestServer } from "./helpers/server.js";

test("healthz answers 200", async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.url}/healthz`);
    assert.equal(res.status, 200);
  } finally {
    await s.stop();
  }
});

test("whoami with an agent token returns the name", async () => {
  const s = await startTestServer();
  try {
    const token = await agentToken(s.db, "bot");
    const res = await fetch(`${s.url}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { actor: { name: string } };
    assert.equal(body.actor.name, "bot");
  } finally {
    await s.stop();
  }
});

test("two servers get different urls and databases", async () => {
  const a = await startTestServer();
  const b = await startTestServer();
  try {
    assert.notEqual(a.url, b.url);
    const token = await agentToken(a.db, "only-in-a");
    const res = await fetch(`${b.url}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("stop resolves and is safe to call twice", async () => {
  const s = await startTestServer();
  await s.stop();
  await s.stop();
});
