import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { BoardEvent } from "@copilotkit/teamkit-protocol";
import { deliverWebhook, signBody, verifySignature } from "../src/triggers/webhook.js";

const event: BoardEvent = {
  cursor: "42",
  kind: "task.completed",
  room: "build/",
  threadId: null,
  actor: null,
  agui: [],
  data: { taskId: "tsk_1", state: "completed" },
  createdAt: "2026-11-19T00:00:00.000Z",
};

interface Seen {
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function receiver(
  handler: (n: number, res: http.ServerResponse) => void,
): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      handler(seen.length, res);
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

const d = (url: string) => ({ url, secret: "s3cret", triggerName: "on-done", event });

test("signature over the raw body verifies; tampering fails", async () => {
  const rx = await receiver((_, res) => res.writeHead(200).end());
  try {
    const r = await deliverWebhook(d(rx.url));
    assert.deepEqual(r, { ok: true, status: 200, attempts: 1 });
    const got = rx.seen[0]!;
    assert.equal(got.body, JSON.stringify({ event }));
    const sig = got.headers["x-teamkit-signature"] as string;
    assert.ok(verifySignature("s3cret", got.body, sig));
    assert.ok(!verifySignature("s3cret", got.body + " ", sig));
    assert.ok(!verifySignature("other", got.body, sig));
    assert.ok(!verifySignature("s3cret", got.body, undefined));
    assert.ok(!verifySignature("s3cret", got.body, "sha256=abc"));
    assert.equal(sig, signBody("s3cret", got.body));
  } finally {
    await rx.close();
  }
});

test("500, 500, 200 succeeds on attempt 3", async () => {
  const rx = await receiver((n, res) => res.writeHead(n < 3 ? 500 : 200).end());
  try {
    const r = await deliverWebhook(d(rx.url), { backoffMs: [10, 10] });
    assert.deepEqual(r, { ok: true, status: 200, attempts: 3 });
  } finally {
    await rx.close();
  }
});

test("always 500 fails after 3 attempts", async () => {
  const rx = await receiver((_, res) => res.writeHead(500).end());
  try {
    const r = await deliverWebhook(d(rx.url), { backoffMs: [10, 10] });
    assert.deepEqual(r, { ok: false, status: 500, attempts: 3 });
  } finally {
    await rx.close();
  }
});

test("headers carry the cursor and trigger name", async () => {
  const rx = await receiver((_, res) => res.writeHead(204).end());
  try {
    await deliverWebhook(d(rx.url));
    const h = rx.seen[0]!.headers;
    assert.equal(h["x-teamkit-event"], "42");
    assert.equal(h["x-teamkit-trigger"], "on-done");
    assert.equal(h["content-type"], "application/json");
    assert.equal(h["user-agent"], "teamkit-webhook/0.1");
  } finally {
    await rx.close();
  }
});

test("a hanging receiver times out", async () => {
  const rx = await receiver(() => {});
  try {
    const r = await deliverWebhook(d(rx.url), { timeoutMs: 100, attempts: 1 });
    assert.deepEqual(r, { ok: false, status: null, attempts: 1 });
  } finally {
    await rx.close();
  }
});

test("redirects are not followed and count as failure", async () => {
  const target = await receiver((_, res) => res.writeHead(200).end());
  const rx = await receiver((_, res) => res.writeHead(302, { location: target.url }).end());
  try {
    const r = await deliverWebhook(d(rx.url), { backoffMs: [10, 10] });
    assert.equal(r.ok, false);
    assert.equal(r.status, 302);
    assert.equal(target.seen.length, 0);
  } finally {
    await rx.close();
    await target.close();
  }
});
