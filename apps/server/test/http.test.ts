import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardEvent, ThreadView } from "@copilotkit/teamkit-protocol";
import { withTestDb } from "./helpers/db.js";
import { agentAuth } from "./helpers/actors.js";
import { createNotifier } from "../src/notifier.js";
import { createApp } from "../src/http/app.js";

type App = ReturnType<typeof createApp>;

async function withApp(fn: (app: App, token: string, db: Parameters<Parameters<typeof withTestDb>[0]>[0]) => Promise<void>): Promise<void> {
  await withTestDb(async (db) => {
    const notifier = await createNotifier(db);
    try {
      const a = await agentAuth(db, "bot");
      await fn(createApp({ db, notifier }), a.token, db);
    } finally {
      await notifier.close();
    }
  });
}

function call(app: App, token: string, path: string, body?: unknown, raw?: string) {
  return app.request(`/v1${path}`, {
    method: body === undefined && raw === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

test("a read-only agent POSTing /posts is 403 forbidden", async () => {
  await withTestDb(async (db) => {
    const notifier = await createNotifier(db);
    try {
      const ro = await agentAuth(db, "ro", [{ room: "*", perms: ["read"] }]);
      const res = await call(createApp({ db, notifier }), ro.token, "/posts", { room: "build", text: "x" });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), {
        error: { code: "forbidden", message: "ro lacks post in build" },
      });
    } finally {
      await notifier.close();
    }
  });
});

test("post then reply shows 2 assistant messages and a cursor", async () => {
  await withApp(async (app, token) => {
    const p = await call(app, token, "/posts", { room: "build", text: "hello" });
    assert.equal(p.status, 201);
    const { threadId } = (await p.json()) as { threadId: string };
    const r = await call(app, token, `/threads/${threadId}/replies`, { text: "again" });
    assert.equal(r.status, 201);
    assert.deepEqual(await r.json(), { ok: true });
    const t = (await (await call(app, token, `/threads/${threadId}`)).json()) as ThreadView;
    assert.equal(t.messages.length, 2);
    assert.ok(t.messages.every((m) => m.role === "assistant"));
    assert.notEqual(t.cursor, "0");
  });
});

test("a 33,000-char reply is 400 invalid_input", async () => {
  await withApp(async (app, token) => {
    const { threadId } = (await (await call(app, token, "/posts", { room: "build", text: "hi" })).json()) as {
      threadId: string;
    };
    const res = await call(app, token, `/threads/${threadId}/replies`, { text: "x".repeat(33_000) });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "invalid_input");
  });
});

test("malformed JSON is 400 invalid_input", async () => {
  await withApp(async (app, token) => {
    const res = await call(app, token, "/posts", undefined, "{not json");
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "invalid_input");
  });
});

test("a label shows up in thread.labels", async () => {
  await withApp(async (app, token) => {
    const { threadId } = (await (await call(app, token, "/posts", { room: "build", text: "hi" })).json()) as {
      threadId: string;
    };
    const res = await call(app, token, `/threads/${threadId}/labels`, { key: "area", value: "ui" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const t = (await (await call(app, token, `/threads/${threadId}`)).json()) as ThreadView;
    assert.equal(t.thread.labels.area, "ui");
  });
});

test("/rooms lists build", async () => {
  await withApp(async (app, token) => {
    await call(app, token, "/posts", { room: "build", text: "hi" });
    const body = (await (await call(app, token, "/rooms")).json()) as { rooms: { name: string }[] };
    assert.deepEqual(body.rooms.map((r) => r.name), ["build"]);
  });
});

test("/room lists the thread; unknown room is 404; missing name is 400", async () => {
  await withApp(async (app, token) => {
    const { threadId } = (await (await call(app, token, "/posts", { room: "build", text: "hi" })).json()) as {
      threadId: string;
    };
    const v = (await (await call(app, token, "/room?name=build")).json()) as { threads: { id: string }[] };
    assert.deepEqual(v.threads.map((t) => t.id), [threadId]);
    const missing = await call(app, token, "/room?name=nope");
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, "not_found");
    const noName = await call(app, token, "/room");
    assert.equal(noName.status, 400);
  });
});

test("/events filters by kind and honors after", async () => {
  await withApp(async (app, token) => {
    const { threadId } = (await (await call(app, token, "/posts", { room: "build", text: "hi" })).json()) as {
      threadId: string;
    };
    await call(app, token, `/threads/${threadId}/replies`, { text: "one" });
    await call(app, token, `/threads/${threadId}/labels`, { key: "k", value: "v" });
    await call(app, token, `/threads/${threadId}/replies`, { text: "two" });
    const all = (await (await call(app, token, "/events?room=build&kind=message.posted")).json()) as {
      events: BoardEvent[];
      cursor: string;
    };
    assert.equal(all.events.length, 2);
    assert.ok(all.events.every((e) => e.kind === "message.posted"));
    const rest = (await (
      await call(app, token, `/events?room=build&kind=message.posted&after=${all.events[0]!.cursor}`)
    ).json()) as { events: BoardEvent[] };
    assert.equal(rest.events.length, 1);
    assert.equal(rest.events[0]!.cursor, all.events[1]!.cursor);
  });
});
