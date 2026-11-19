import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSse, type SseFrame } from "../src/sse.js";

const enc = new TextEncoder();

async function* chunks(parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield p;
}

function stream(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

async function collect(it: AsyncIterable<SseFrame>): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const f of it) out.push(f);
  return out;
}

function bytewise(s: string): Uint8Array[] {
  return Array.from(enc.encode(s)).map((b) => new Uint8Array([b]));
}

const BASIC = 'id: 7\nevent: board\ndata: {"a":1}\n\n';

test("parses a frame with id, event and data (async iterable and ReadableStream)", async () => {
  const expected = [{ id: "7", event: "board", data: '{"a":1}' }];
  assert.deepEqual(await collect(parseSse(chunks([enc.encode(BASIC)]))), expected);
  assert.deepEqual(await collect(parseSse(stream([enc.encode(BASIC)]))), expected);
});

test("joins multi-line data with newline", async () => {
  const f = await collect(parseSse(chunks([enc.encode("data: a\ndata: b\ndata:c\n\n")])));
  assert.deepEqual(f, [{ event: "message", data: "a\nb\nc" }]);
});

test("skips comments, handles CRLF and bare CR", async () => {
  const input = ": ping\r\nid: 1\r\ndata: x\r\n\r\n: ping\rid: 2\rdata: y\r\r";
  const f = await collect(parseSse(chunks([enc.encode(input)])));
  assert.deepEqual(f, [
    { id: "1", event: "message", data: "x" },
    { id: "2", event: "message", data: "y" },
  ]);
});

test("byte-by-byte split yields identical frames, including split multi-byte chars and CRLF", async () => {
  const input = "id: 1\r\nevent: board\r\ndata: café\r\n\r\n: ping\n\nid: 2\ndata: éé\n\n";
  const whole = await collect(parseSse(chunks([enc.encode(input)])));
  assert.equal(whole.length, 2);
  assert.equal(whole[0]!.data, "café");
  assert.deepEqual(await collect(parseSse(chunks(bytewise(input)))), whole);
  assert.deepEqual(await collect(parseSse(stream(bytewise(input)))), whole);
});

test("event defaults to message; frame without data is not dispatched", async () => {
  const f = await collect(parseSse(chunks([enc.encode("event: x\n\nid: 3\n\ndata: z\n\n")])));
  assert.deepEqual(f, [{ id: "3", event: "message", data: "z" }]);
});

test("drops an incomplete trailing frame", async () => {
  const f = await collect(parseSse(chunks([enc.encode("data: a\n\ndata: b\n")])));
  assert.deepEqual(f, [{ event: "message", data: "a" }]);
});

test("aborting mid-stream ends iteration without throwing", async () => {
  const ac = new AbortController();
  async function* slow(): AsyncGenerator<Uint8Array> {
    yield enc.encode("data: one\n\n");
    await new Promise((r) => setTimeout(r, 10));
    yield enc.encode("data: two\n\n");
    await new Promise(() => {}); // never ends
  }
  const got: SseFrame[] = [];
  for await (const f of parseSse(slow(), ac.signal)) {
    got.push(f);
    if (got.length === 2) ac.abort();
  }
  assert.equal(got.length, 2);

  const ac2 = new AbortController();
  const rs = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("data: one\n\n"));
    },
  });
  const got2: SseFrame[] = [];
  for await (const f of parseSse(rs, ac2.signal)) {
    got2.push(f);
    ac2.abort();
  }
  assert.equal(got2.length, 1);
});
