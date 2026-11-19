import { test } from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import type { BoardEvent } from "@copilotkit/teamkit-protocol";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { countingNotifier, liveCount, serveApp, type CountingNotifier } from "./helpers/notifier.js";
import { createNotifier } from "../src/notifier.js";
import { createApp, type AppOptions } from "../src/http/app.js";
import { listTokens, revokeToken } from "../src/store/actors.js";
import { currentCursor, listEvents } from "../src/store/events.js";
import { post } from "../src/store/threads.js";

type ReadResult = { done: boolean; value?: Uint8Array };

interface Frame {
  id?: string;
  event?: string;
  data?: string;
}

/** Reads SSE frames from a response body as they arrive; comments are skipped. `timeoutMs` bounds the whole call. */
function frameReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // A read that timed out stays pending, so the next call reuses it and no chunk is lost.
  let pending: Promise<ReadResult> | null = null;
  return async function next(timeoutMs = 3000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = buf.indexOf("\n\n");
      if (i >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (raw.startsWith(":")) continue;
        const f: Frame = {};
        for (const line of raw.split("\n")) {
          const j = line.indexOf(":");
          const k = line.slice(0, j);
          const v = line.slice(j + 1).replace(/^ /, "");
          if (k === "id") f.id = v;
          else if (k === "event") f.event = v;
          else if (k === "data") f.data = v;
        }
        return f;
      }
      pending ??= reader.read();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("timed out waiting for an SSE frame")), deadline - Date.now());
      });
      let result: ReadResult;
      try {
        result = await Promise.race([pending, timeout]);
      } finally {
        clearTimeout(timer);
      }
      pending = null;
      const { value, done } = result;
      if (done) throw new Error("stream ended");
      buf += decoder.decode(value, { stream: true });
    }
  };
}

async function withApp(
  fn: (ctx: {
    db: Parameters<Parameters<typeof withTestDb>[0]>[0];
    app: ReturnType<typeof createApp>;
    token: string;
    notifier: CountingNotifier;
  }) => Promise<void>,
  opts?: AppOptions,
): Promise<void> {
  await withTestDb(async (db) => {
    const notifier = countingNotifier(await createNotifier(db));
    try {
      const a = await agentAuth(db, "bot");
      await fn({ db, app: createApp({ db, notifier }, opts), token: a.token, notifier });
    } finally {
      await notifier.close();
    }
  });
}

function open(
  app: ReturnType<typeof createApp>,
  token: string,
  query: string,
  extra: Record<string, string> = {},
) {
  const ac = new AbortController();
  const p = app.request(`/v1/events/stream${query}`, {
    headers: { authorization: `Bearer ${token}`, ...extra },
    signal: ac.signal,
  });
  return { ac, res: p };
}

test("after=<cursor> replays in order with id = cursor, then a new post arrives live", async () => {
  await withApp(async ({ db, app, token }) => {
    const alice = await personAuth(db, "alice");
    await post(db, alice, { room: "build", text: "one" });
    const before = (await listEvents(db, {})).cursor;
    await post(db, alice, { room: "build", text: "two" });
    await post(db, alice, { room: "build", text: "three" });
    const expected = (await listEvents(db, { after: before })).events;
    assert.equal(expected.length, 2);

    const { ac, res } = open(app, token, `?after=${before}`);
    const r = await res;
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const next = frameReader(r);
    for (const e of expected) {
      const f = await next();
      assert.equal(f.id, e.cursor);
      assert.equal(f.event, "board");
      assert.deepEqual(JSON.parse(f.data!) as BoardEvent, e);
    }
    const t0 = Date.now();
    await post(db, alice, { room: "build", text: "live" });
    const f = await next(1000);
    assert.ok(Date.now() - t0 < 1000);
    assert.ok(BigInt(f.id!) > BigInt(expected[1]!.cursor));
    ac.abort();
  });
});

test("abort then reconnect with Last-Event-ID: no duplicates, no gaps", async () => {
  await withApp(async ({ db, app, token, notifier }) => {
    const alice = await personAuth(db, "alice");
    const seen: string[] = [];
    const first = open(app, token, "?after=0");
    await post(db, alice, { room: "build", text: "a" });
    const n1 = frameReader(await first.res);
    seen.push((await n1()).id!);
    await post(db, alice, { room: "build", text: "b" });
    seen.push((await n1()).id!);
    first.ac.abort();
    // Posts made while disconnected must be replayed on resume.
    await post(db, alice, { room: "build", text: "c" });
    await post(db, alice, { room: "build", text: "d" });

    assert.equal(await liveCount(notifier, 0), 0, "the aborted stream unsubscribed");
    const second = open(app, token, "", { "last-event-id": seen[seen.length - 1]! });
    const n2 = frameReader(await second.res);
    seen.push((await n2()).id!);
    seen.push((await n2()).id!);
    await post(db, alice, { room: "build", text: "e" });
    seen.push((await n2(1000)).id!);
    assert.equal(notifier.live(), 1);
    second.ac.abort();

    const all = (await listEvents(db, { after: "0" })).events.map((e) => e.cursor);
    assert.deepEqual(seen, all);
    for (let i = 1; i < seen.length; i++) assert.ok(BigInt(seen[i]!) > BigInt(seen[i - 1]!));
    assert.equal(await liveCount(notifier, 0), 0, "every stream unsubscribed");
  });
});

test("destroying the socket mid-stream unsubscribes", async () => {
  await withApp(async ({ app, token, notifier }) => {
    const srv = await serveApp(app);
    try {
      const req = get(`${srv.url}/v1/events/stream`, { headers: { authorization: `Bearer ${token}` } });
      req.on("error", () => {});
      // The live tail's id-only frame shows the stream is open and subscribed.
      const first = await new Promise<string>((resolve, reject) => {
        req.on("response", (res) => res.once("data", (b: Buffer) => resolve(b.toString())));
        req.on("error", reject);
      });
      assert.match(first, /^id: \d+\n\n/);
      assert.equal(notifier.live(), 1);
      req.socket!.destroy();
      assert.equal(await liveCount(notifier, 0), 0);
    } finally {
      await srv.close();
    }
  });
});

test("no after means a live tail with no replay of old events, opened by an id-only frame", async () => {
  await withApp(async ({ db, app, token }) => {
    const alice = await personAuth(db, "alice");
    await post(db, alice, { room: "build", text: "old" });
    const head = await currentCursor(db);
    const { ac, res } = open(app, token, "");
    const next = frameReader(await res);
    assert.deepEqual(await next(), { id: head });
    await assert.rejects(next(400), /timed out/);
    await post(db, alice, { room: "build", text: "new" });
    const f = await next(1000);
    const all = (await listEvents(db, { after: "0" })).events;
    assert.equal(f.id, all[all.length - 1]!.cursor);
    assert.ok(all.length > 1);
    ac.abort();
  });
});

test("reconnecting with the id-only frame's cursor replays what was posted in between", async () => {
  await withApp(async ({ db, app, token }) => {
    const alice = await personAuth(db, "alice");
    await post(db, alice, { room: "build", text: "old" });
    const first = open(app, token, "");
    const start = (await frameReader(await first.res)()).id!;
    first.ac.abort();
    await post(db, alice, { room: "build", text: "while away" });
    const second = open(app, token, "", { "last-event-id": start });
    const f = await frameReader(await second.res)();
    assert.equal(f.event, "board");
    assert.ok(f.data!.includes("while away"));
    second.ac.abort();
  });
});

test("a revoked token's stream ends within one ping; a valid one survives its pings", async () => {
  const pingMs = 200;
  await withApp(
    async ({ db, app, token, notifier }) => {
      const { ac, res } = open(app, token, "");
      const next = frameReader(await res);
      await next(); // id-only frame
      // Pings carry on while the token is valid (comments are skipped, so this times out).
      await assert.rejects(next(pingMs * 3), /timed out/);
      const tok = (await listTokens(db)).find((t) => t.actorName === "bot")!;
      await revokeToken(db, tok.id);
      const t0 = Date.now();
      await assert.rejects(next(pingMs + 1000), /stream ended/);
      const dt = Date.now() - t0;
      assert.ok(dt < pingMs + 400, `ended ${dt} ms after revoke`);
      assert.equal(await liveCount(notifier, 0), 0);
      ac.abort();
    },
    { streamPingMs: pingMs },
  );
});

test("a stream ends at its lifetime cap and Last-Event-ID resumes it", async () => {
  await withApp(
    async ({ db, app, token, notifier }) => {
      const alice = await personAuth(db, "alice");
      await post(db, alice, { room: "build", text: "one" });
      const first = open(app, token, "?after=0");
      const n1 = frameReader(await first.res);
      const last = (await n1()).id!;
      await assert.rejects(n1(2000), /stream ended/);
      assert.equal(await liveCount(notifier, 0), 0);
      await post(db, alice, { room: "build", text: "two" });
      const second = open(app, token, "", { "last-event-id": last });
      const f = await frameReader(await second.res)();
      assert.ok(f.data!.includes("two"));
      second.ac.abort();
    },
    { streamMaxMs: 300 },
  );
});

test("a bad cursor or an unreadable room is a JSON error before the stream starts", async () => {
  await withApp(async ({ db, app }) => {
    const limited = await agentAuth(db, "limited", [{ room: "open", perms: ["read"] }]);
    const bad = await app.request("/v1/events/stream?after=nope", {
      headers: { authorization: `Bearer ${limited.token}` },
    });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: { code: string } }).error.code, "invalid_input");
    const denied = await app.request("/v1/events/stream?room=secret", {
      headers: { authorization: `Bearer ${limited.token}` },
    });
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as { error: { code: string } }).error.code, "forbidden");
  });
});

test("HEAD on the stream answers with headers only and leaves no subscription behind", async () => {
  await withApp(async ({ app, token, notifier }) => {
    const srv = await serveApp(app);
    try {
      const head = (path: string, auth = token) =>
        fetch(`${srv.url}${path}`, { method: "HEAD", headers: { authorization: `Bearer ${auth}` } });
      const replies = await Promise.all(Array.from({ length: 20 }, () => head("/v1/events/stream")));
      for (const r of replies) {
        assert.equal(r.status, 200);
        assert.match(r.headers.get("content-type") ?? "", /^text\/event-stream/);
      }
      assert.equal((await head("/v1/events/stream", "tk_bogus")).status, 401);
      assert.equal((await head("/v1/events/stream?after=nope")).status, 400);
      // The claim-next long poll is POST only: HEAD never reaches it.
      assert.equal((await head("/v1/tasks/claim-next")).status, 404);
      assert.equal(await liveCount(notifier, 0, 500), 0, "no HEAD left a subscription");
    } finally {
      await srv.close();
    }
  });
});
