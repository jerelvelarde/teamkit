import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardEvent } from "@copilotkit/teamkit-protocol";
import { agentToken, startTestServer } from "../../../apps/server/test/helpers/server.js";
import { createClient, TeamkitError } from "../src/client.js";

test("every client method round-trips against a real server", async () => {
  const srv = await startTestServer();
  try {
    const token = await agentToken(srv.db, "bot");
    const c = createClient({ url: srv.url, token });

    const me = await c.whoami();
    assert.equal(me.actor.name, "bot");
    assert.equal(me.scope, "agent");

    const { threadId } = await c.post("build", "hello team");
    await c.reply(threadId, "a reply");
    await c.label(threadId, "kind", "chat");
    const thread = await c.thread(threadId);
    assert.ok(JSON.stringify(thread).includes("a reply"));

    const rooms = await c.rooms();
    assert.ok(rooms.some((r) => r.name === "build"));
    const view = await c.room("build");
    assert.ok(view.threads.some((t) => t.id === threadId));
    const viewAfter = await c.room("build", { after: "0" });
    assert.ok(viewAfter);

    assert.equal(await c.claimNext("build", { waitMs: 0 }), null);

    const t1 = await c.createTask({ room: "build", brief: "one", labels: { team: "a b", lane: "v&x=1" } });
    assert.equal(t1.state, "ready");
    const listed = await c.tasks({ room: "build", state: "ready", labels: { team: "a b", lane: "v&x=1" } });
    assert.deepEqual(listed.map((t) => t.id), [t1.id]);
    assert.equal((await c.tasks({ room: "build", labels: { team: "zzz" } })).length, 0);
    assert.ok((await c.tasks({ state: "all" })).length >= 1);

    const claim = await c.claim(t1.id);
    assert.equal(claim.task.id, t1.id);
    const renewed = await c.renew(t1.id, claim.claimId);
    assert.ok(renewed.leaseExpiresAt);
    const released = await c.release(t1.id, claim.claimId);
    assert.equal(released.state, "ready");

    const claimed = await c.claimNext("build", { waitMs: 0 });
    assert.equal(claimed?.task.id, t1.id);
    const blocked = await c.block(t1.id, claimed!.claimId, { question: "which?" });
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.block?.kind, "needs_input");
    const answered = await c.answer(t1.id, { text: "this one" });
    assert.notEqual(answered.state, "blocked");

    const c2 = await c.claimNext("build", { waitMs: 0 });
    assert.equal(c2?.task.id, t1.id);
    const done = await c.complete(t1.id, c2!.claimId, "all done");
    assert.equal(done.state, "completed");

    const t2 = await c.createTask({ room: "build", brief: "two" });
    const claim2 = await c.claim(t2.id);
    const failed = await c.fail(t2.id, claim2.claimId, "broke");
    assert.equal(failed.state, "failed");

    const plan = await c.createPlan("build", [
      { key: "a", text: "first" },
      { key: "b", text: "second", needs: [{ key: "a" }] },
    ]);
    assert.deepEqual(Object.keys(plan).sort(), ["a", "b"]);

    const feed = await c.events({ room: "build", kinds: ["task.created", "message.posted"], limit: 100, after: "0" });
    assert.ok(feed.events.length > 0);
    assert.ok(typeof feed.cursor === "string");
  } finally {
    await srv.stop();
  }
});

test("stream yields an event posted after it opened, and abort ends it quietly", async () => {
  const srv = await startTestServer();
  try {
    const token = await agentToken(srv.db, "bot");
    const c = createClient({ url: srv.url, token });
    const ac = new AbortController();
    const got: BoardEvent[] = [];
    const reader = (async () => {
      for await (const e of c.stream({ room: "build" }, { signal: ac.signal })) {
        got.push(e);
        ac.abort();
      }
    })();
    await new Promise((r) => setTimeout(r, 300));
    await c.post("build", "streamed");
    await reader;
    assert.equal(got.length, 1);
    assert.ok(JSON.stringify(got[0]).includes("streamed"));
  } finally {
    await srv.stop();
  }
});

test("a bad token throws TeamkitError unauthorized with status 401", async () => {
  const srv = await startTestServer();
  try {
    const c = createClient({ url: srv.url, token: "tk_nope" });
    await assert.rejects(c.whoami(), (e: unknown) => {
      assert.ok(e instanceof TeamkitError);
      assert.equal(e.code, "unauthorized");
      assert.equal(e.status, 401);
      return true;
    });
  } finally {
    await srv.stop();
  }
});

test("a double claim throws task_claimed; a non-JSON error becomes http_error", async () => {
  const srv = await startTestServer();
  try {
    const token = await agentToken(srv.db, "bot");
    const c = createClient({ url: srv.url, token });
    const t = await c.createTask({ room: "build", brief: "x" });
    await c.claim(t.id);
    await assert.rejects(c.claim(t.id), (e: unknown) => e instanceof TeamkitError && e.code === "task_claimed");

    const html = createClient({
      url: "http://x",
      token: "t",
      fetch: async () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    await assert.rejects(html.whoami(), (e: unknown) => {
      assert.ok(e instanceof TeamkitError);
      assert.equal(e.code, "http_error");
      assert.equal(e.status, 502);
      assert.match(e.message, /bad gateway/);
      return true;
    });
  } finally {
    await srv.stop();
  }
});

test("complete with a null result omits it", async () => {
  const srv = await startTestServer();
  try {
    const token = await agentToken(srv.db, "bot");
    const c = createClient({ url: srv.url, token });
    const t = await c.createTask({ room: "build", brief: "x" });
    const claim = await c.claim(t.id);
    const done = await c.complete(t.id, claim.claimId, null);
    assert.equal(done.state, "completed");
  } finally {
    await srv.stop();
  }
});
