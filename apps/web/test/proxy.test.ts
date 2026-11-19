import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { MAX_BODY_BYTES } from "@copilotkit/teamkit-protocol";
import { proxy } from "../lib/proxy.js";

/** A request body that hands out `total` bytes in 64 KiB chunks and counts how many were pulled. */
function counted(total: number): { stream: ReadableStream<Uint8Array>; pulled(): number } {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      const n = Math.min(65_536, total - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(120));
    },
  }, { highWaterMark: 0 }); // pull only when someone reads
  return { stream, pulled: () => sent };
}

function streamed(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request("http://web.test/v1/echo", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    duplex: "half",
  } as RequestInit);
}

let server: Server;
let upstream: string;
let sseClosed: Promise<void>;
let resolveSseClosed: () => void;
const seen: Record<string, string | string[] | undefined>[] = [];

before(async () => {
  sseClosed = new Promise((r) => (resolveSseClosed = r));
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/v1/echo") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen.push(req.headers);
        const body = JSON.stringify({
          method: req.method,
          path: url.pathname,
          query: url.search,
          cookie: req.headers.cookie,
          body: Buffer.concat(chunks).toString(),
        });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "set-cookie": ["a=1; HttpOnly", "b=2; Path=/"],
          "keep-alive": "timeout=5",
        });
        res.end(body);
      });
    } else if (url.pathname === "/v1/sse") {
      seen.push(req.headers);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("id: 1\ndata: one\n\n");
      const t = setTimeout(() => {
        res.write("id: 2\ndata: two\n\n");
        res.end();
      }, 500);
      res.on("close", () => {
        clearTimeout(t);
        resolveSseClosed();
      });
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe("proxy", () => {
  it("forwards Slack's signature headers and the body unchanged for a slash command", async () => {
    const body = "command=%2Fteamkit&text=decide+Freeze+writes";
    await proxy(
      new Request("http://web.test/v1/echo", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-signature": "v0=abc", "x-slack-request-timestamp": "1763560000" },
        body,
      }),
      ["echo"],
      upstream,
    );
    const h = seen[seen.length - 1]!;
    assert.deepEqual([h["x-slack-signature"], h["x-slack-request-timestamp"]], ["v0=abc", "1763560000"]);
  });

  it("forwards method, query, cookie and body, keeps set-cookie, drops framing headers", async () => {
    const req = new Request("http://web.test/v1/echo?x=1", {
      method: "POST",
      headers: { cookie: "teamkit_session=abc", "content-type": "application/json", "x-evil": "1", connection: "close" },
      body: JSON.stringify({ hello: "world" }),
    });
    const res = await proxy(req, ["echo"], upstream);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      method: "POST",
      path: "/v1/echo",
      query: "?x=1",
      cookie: "teamkit_session=abc",
      body: '{"hello":"world"}',
    });
    assert.deepEqual(res.headers.getSetCookie(), ["a=1; HttpOnly", "b=2; Path=/"]);
    for (const h of ["content-length", "content-encoding", "transfer-encoding", "keep-alive"]) {
      assert.equal(res.headers.get(h), null, h);
    }
    const last = seen[seen.length - 1];
    assert.equal(last["x-evil"], undefined);
  });

  it("refuses a declared length over the limit with 413 before reading the body", async () => {
    const before = seen.length;
    const body = counted(MAX_BODY_BYTES * 4);
    const res = await proxy(streamed(body.stream, { "content-length": String(MAX_BODY_BYTES + 1) }), ["echo"], upstream);
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: { code: "too_large", message: "request body too large" } });
    assert.equal(body.pulled(), 0, "no byte of the body was read");
    assert.equal(seen.length, before, "the server was never called");
  });

  it("cuts off a chunked body with no length once it passes the limit, with 413", async () => {
    const body = counted(MAX_BODY_BYTES * 64);
    const res = await proxy(streamed(body.stream), ["echo"], upstream);
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, "too_large");
    assert.ok(body.pulled() < MAX_BODY_BYTES * 2, `stopped reading early (read ${body.pulled()} bytes)`);
  });

  it("forwards a streamed body of exactly the limit intact", async () => {
    const res = await proxy(streamed(counted(MAX_BODY_BYTES).stream), ["echo"], upstream);
    assert.equal(res.status, 200);
    const got = (await res.json()) as { body: string };
    assert.equal(got.body.length, MAX_BODY_BYTES);
    assert.equal(got.body, "x".repeat(MAX_BODY_BYTES));
  });

  it("streams SSE without buffering, forwards Last-Event-ID, and sets no-buffer headers", async () => {
    const t0 = Date.now();
    const res = await proxy(
      new Request("http://web.test/v1/sse", { headers: { "last-event-id": "7", accept: "text/event-stream" } }),
      ["sse"],
      upstream,
    );
    assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(res.headers.get("x-accel-buffering"), "no");
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.ok(Date.now() - t0 < 300, "first chunk arrived early");
    assert.match(new TextDecoder().decode(first.value), /data: one/);
    assert.equal(seen[seen.length - 1]["last-event-id"], "7");
    await reader.cancel();
  });

  it("aborts the upstream request when the browser disconnects", async () => {
    sseClosed = new Promise((r) => (resolveSseClosed = r));
    const ac = new AbortController();
    const res = await proxy(new Request("http://web.test/v1/sse", { signal: ac.signal }), ["sse"], upstream);
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await Promise.race([
      sseClosed,
      new Promise((_, rej) => setTimeout(() => rej(new Error("upstream not closed")), 400)),
    ]);
    await reader.cancel().catch(() => {});
  });

  it("returns 502 bad_gateway when the upstream is unreachable", async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise((r) => dead.close(r));
    const res = await proxy(new Request("http://web.test/v1/echo"), ["echo"], `http://127.0.0.1:${port}`);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), {
      error: { code: "bad_gateway", message: "teamkit-server is unreachable" },
    });
  });
});
