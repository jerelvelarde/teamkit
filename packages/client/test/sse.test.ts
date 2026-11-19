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

test("CR, LF, LF split across chunks ends the frame", async () => {
  const parts = ["data: a\r", "\n", "\n", "data: b\n\n"].map((s) => enc.encode(s));
  const expected = [
    { event: "message", data: "a" },
    { event: "message", data: "b" },
  ];
  assert.deepEqual(await collect(parseSse(chunks(parts))), expected);
  assert.deepEqual(await collect(parseSse(stream(parts))), expected);
});

test("aborting while an async generator source is parked in next() ends iteration and returns the source", async () => {
  const ac = new AbortController();
  let unpark!: () => void;
  const parked = new Promise<void>((r) => (unpark = r));
  let finalized = false;
  async function* source(): AsyncGenerator<Uint8Array> {
    try {
      yield enc.encode("data: one\n\n");
      await parked;
      yield enc.encode("data: late\n\n");
    } finally {
      finalized = true;
    }
  }
  const gen = source();
  let returnCalled = false;
  const origReturn = gen.return.bind(gen);
  gen.return = (v) => {
    returnCalled = true;
    return origReturn(v);
  };
  const timer = setTimeout(() => ac.abort(), 20);
  const got: SseFrame[] = [];
  try {
    for await (const f of parseSse(gen, ac.signal)) got.push(f);
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(got, [{ event: "message", data: "one" }]);
  assert.equal(returnCalled, true, "the source's return() must be called on abort");
  // return() is queued behind the parked next(); once that settles, the source finalizes.
  unpark();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(finalized, true);
});

test("aborting while a ReadableStream read is pending ends iteration and cancels the stream", async () => {
  const ac = new AbortController();
  let cancelled = false;
  const rs = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("data: one\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const timer = setTimeout(() => ac.abort(), 20);
  const got: SseFrame[] = [];
  try {
    for await (const f of parseSse(rs, ac.signal)) got.push(f);
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(got, [{ event: "message", data: "one" }]);
  assert.equal(cancelled, true);
});

test("an already-aborted signal yields nothing and stops the source", async () => {
  const ac = new AbortController();
  ac.abort();

  let cancelled = false;
  const rs = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("data: one\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.deepEqual(await collect(parseSse(rs, ac.signal)), []);
  assert.equal(cancelled, true);
  assert.equal(rs.locked, false);

  let returnCalled = false;
  const it: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => Promise.resolve({ done: false, value: enc.encode("data: one\n\n") }),
    return: () => {
      returnCalled = true;
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  assert.deepEqual(await collect(parseSse(it, ac.signal)), []);
  assert.equal(returnCalled, true);
});
