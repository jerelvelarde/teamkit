import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { proxy } from "../lib/proxy.ts";

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
