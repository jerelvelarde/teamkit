import { test } from "node:test";
import assert from "node:assert/strict";
import { callSlack } from "../src/slack/web-api.js";
import { CHANNEL } from "./helpers/billing.js";
import { fakeSlack } from "./helpers/fake-slack.js";

const TOKEN = "fake-bot-token-for-tests";

test("callSlack posts JSON with the bearer to <apiBase>/<method> and returns the ts", async () => {
  const slack = await fakeSlack();
  try {
    const r = await callSlack({ token: TOKEN, apiBase: slack.apiBase }, "chat.update", { channel: CHANNEL.migration, ts: "5.000", text: "Status for billing-migration" });
    assert.deepEqual(r, { kind: "ok", ts: "5.000" });
    assert.equal(slack.requests[0]!.method, "chat.update");
    assert.equal(slack.requests[0]!.auth, `Bearer ${TOKEN}`);
    assert.equal(slack.requests[0]!.contentType, "application/json; charset=utf-8");
    assert.deepEqual(await callSlack({ token: TOKEN, apiBase: slack.apiBase }, "pins.add", { channel: CHANNEL.migration, timestamp: "5.000" }), { kind: "ok", ts: null });
  } finally {
    await slack.close();
  }
});

test("Slack errors keep their code: already_pinned and message_not_found are permanent", async () => {
  const slack = await fakeSlack([{ body: { ok: false, error: "already_pinned" } }, { body: { ok: false, error: "message_not_found" } }]);
  try {
    const api = { token: TOKEN, apiBase: slack.apiBase };
    assert.deepEqual(await callSlack(api, "pins.add", { channel: CHANNEL.prod, timestamp: "1.000" }),
      { kind: "permanent", reason: "slack error already_pinned", error: "already_pinned" });
    assert.deepEqual(await callSlack(api, "chat.update", { channel: CHANNEL.prod, ts: "1.000", text: "x" }),
      { kind: "permanent", reason: "slack error message_not_found", error: "message_not_found" });
  } finally {
    await slack.close();
  }
});

test("a 429 with Retry-After, invalid_auth and a network error are retries", async () => {
  const slack = await fakeSlack([
    { status: 429, headers: { "retry-after": "7" }, body: { ok: false, error: "ratelimited" } },
    { body: { ok: false, error: "invalid_auth" } },
  ]);
  try {
    const api = { token: TOKEN, apiBase: slack.apiBase };
    assert.deepEqual(await callSlack(api, "chat.postMessage", { channel: CHANNEL.prod, text: "x" }), { kind: "retry", reason: "http 429", afterMs: 7000 });
    assert.deepEqual(await callSlack(api, "chat.postMessage", { channel: CHANNEL.prod, text: "x" }), { kind: "retry", reason: "slack error invalid_auth", afterMs: null });
    const down = { token: TOKEN, fetch: (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch };
    assert.deepEqual(await callSlack(down, "chat.postMessage", { channel: CHANNEL.prod, text: "x" }), { kind: "retry", reason: "request failed (TypeError)", afterMs: null });
  } finally {
    await slack.close();
  }
});

test("a non-429, non-5xx HTTP failure is permanent with an http_<status> code", async () => {
  const slack = await fakeSlack([{ status: 404, body: {} }]);
  try {
    assert.deepEqual(await callSlack({ token: TOKEN, apiBase: slack.apiBase }, "chat.postMessage", { channel: CHANNEL.prod, text: "x" }),
      { kind: "permanent", reason: "http 404", error: "http_404" });
  } finally {
    await slack.close();
  }
});
