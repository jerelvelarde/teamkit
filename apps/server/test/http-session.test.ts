import { test } from "node:test";
import assert from "node:assert/strict";
import { newId, newTokenSecret, type ActorRef } from "@copilotkit/teamkit-protocol";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import type { Db } from "../src/db/pool.js";
import { withTestDb } from "./helpers/db.js";
import { agentAuth, personAuth } from "./helpers/actors.js";
import { createNotifier } from "../src/notifier.js";
import { createApp, type AppOptions } from "../src/http/app.js";
import { requireAdmin } from "../src/http/auth.js";
import { consumeSignInLink, invitePerson, revokeSession } from "../src/store/people.js";
import { createTask } from "../src/store/tasks.js";
import { claimTask } from "../src/store/claims.js";
import { block } from "../src/store/blocks.js";
import { setRoom } from "../src/store/rooms.js";

type App = ReturnType<typeof createApp>;

async function withApp(fn: (ctx: { db: Db; app: App }) => Promise<void>, opts?: AppOptions): Promise<void> {
  await withTestDb(async (db) => {
    const notifier = await createNotifier(db);
    try {
      await fn({ db, app: createApp({ db, notifier }, opts) });
    } finally {
      await notifier.close();
    }
  });
}

/** A signed-in person: an invite link consumed into a session. */
async function signIn(db: Db, name: string, role: "admin" | "member" = "admin"): Promise<{ actor: ActorRef; secret: string }> {
  const invite = await invitePerson(db, { name, role });
  const s = await consumeSignInLink(db, invite.secret);
  return { actor: s.actor, secret: s.sessionSecret };
}

/** An admin-scope token, as the command-line sign-in mints for a person. */
async function adminScopeToken(db: Db, actorId: string): Promise<string> {
  const secret = newTokenSecret();
  await db`insert into tokens (id, actor_id, hash, scope) values (${newId("tok")}, ${actorId}, ${hashToken(secret)}, 'admin')`;
  return secret;
}

const cookie = (secret: string) => ({ cookie: `teamkit_session=${secret}` });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const JSON_TYPE = { "content-type": "application/json" };

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

test("whoami by session cookie is the person, with no scope", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada");
    const res = await app.request("/v1/whoami", { headers: cookie(ada.secret) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { actor: ada.actor, scope: null, role: "admin" });
  });
});

test("a cookie-authenticated POST must send content-type: application/json", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada");
    const body = JSON.stringify({ room: "build", text: "hi" });
    const refused = { code: "invalid_input", message: "cookie-authenticated requests must send content-type: application/json" };

    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: { ...cookie(ada.secret), "content-type": type },
        body,
      });
      assert.equal(res.status, 400, type);
      assert.deepEqual(await errorOf(res), refused);
    }

    // A byte body sets no content-type of its own.
    const bare = new Request("http://x/v1/posts", {
      method: "POST",
      headers: cookie(ada.secret),
      body: new TextEncoder().encode(body),
    });
    assert.equal(bare.headers.get("content-type"), null);
    const none = await app.request(bare);
    assert.equal(none.status, 400);
    assert.deepEqual(await errorOf(none), refused);

    const ok = await app.request("/v1/posts", {
      method: "POST",
      headers: { ...cookie(ada.secret), "content-type": "Application/JSON; charset=utf-8" },
      body,
    });
    assert.equal(ok.status, 201);
  });
});

test("bearer tokens work as before: no content-type rule, and a bad bearer never falls back to the cookie", async () => {
  await withApp(async ({ db, app }) => {
    const bot = await agentAuth(db, "bot");
    const ada = await signIn(db, "ada");
    const res = await app.request("/v1/posts", {
      method: "POST",
      headers: { ...bearer(bot.token), "content-type": "text/plain" },
      body: JSON.stringify({ room: "build", text: "hi" }),
    });
    assert.equal(res.status, 201);

    const both = await app.request("/v1/whoami", { headers: { ...bearer(bot.token), ...cookie(ada.secret) } });
    assert.equal(((await both.json()) as { actor: ActorRef }).actor.name, "bot");

    const bad = await app.request("/v1/whoami", { headers: { ...bearer("tk_nope"), ...cookie(ada.secret) } });
    assert.equal(bad.status, 401);
    assert.deepEqual(await errorOf(bad), { code: "unauthorized", message: "invalid token" });
  });
});

test("a bad, revoked or expired session cookie is 401", async () => {
  await withApp(async ({ db, app }) => {
    const expired = { code: "unauthorized", message: "session expired or invalid" };
    const bad = await app.request("/v1/whoami", { headers: cookie("ts_nope") });
    assert.equal(bad.status, 401);
    assert.deepEqual(await errorOf(bad), expired);

    const ada = await signIn(db, "ada");
    await revokeSession(db, ada.secret);
    const revoked = await app.request("/v1/whoami", { headers: cookie(ada.secret) });
    assert.equal(revoked.status, 401);
    assert.deepEqual(await errorOf(revoked), expired);

    const bob = await signIn(db, "bob", "member");
    await db`update sessions set expires_at = clock_timestamp() - interval '1 second'
             where hash = ${hashToken(bob.secret)}`;
    const old = await app.request("/v1/whoami", { headers: cookie(bob.secret) });
    assert.equal(old.status, 401);
    assert.deepEqual(await errorOf(old), expired);

    const empty = await app.request("/v1/whoami", { headers: { cookie: "teamkit_session=" } });
    assert.equal(empty.status, 401);
    assert.deepEqual(await errorOf(empty), { code: "unauthorized", message: "missing bearer token" });
  });
});

test("an admin-scope token is refused on every non-admin route", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada");
    const token = await adminScopeToken(db, ada.actor.id);
    const gated = { code: "forbidden", message: "admin tokens only work for admin commands" };

    const tasks = await app.request("/v1/tasks", { headers: bearer(token) });
    assert.equal(tasks.status, 403);
    assert.deepEqual(await errorOf(tasks), gated);

    const writes = ["/v1/threads/x/replies", "/v1/posts", "/v1/tasks/x/answer", "/v1/tasks/claim-next"];
    for (const path of writes) {
      const res = await app.request(path, {
        method: "POST",
        headers: { ...bearer(token), ...JSON_TYPE },
        body: JSON.stringify({ text: "hi", room: "build", choice: "approve" }),
      });
      assert.equal(res.status, 403, path);
      assert.deepEqual(await errorOf(res), gated);
    }
    for (const path of ["/v1/events/stream?after=0", "/v1/events", "/v1/rooms", "/v1/adminx/people"]) {
      const res = await app.request(path, { headers: bearer(token) });
      assert.equal(res.status, 403, path);
    }

    const who = await app.request("/v1/whoami", { headers: bearer(token) });
    assert.equal(who.status, 200);
    assert.deepEqual(await who.json(), { actor: ada.actor, scope: "admin", role: "admin" });

    // Admin paths get past the gate: an admin-scope token reads, but writes need a session.
    const admin = await app.request("/v1/admin/people", { headers: bearer(token) });
    assert.equal(admin.status, 200);
    const write = await app.request("/v1/admin/people", {
      method: "POST",
      headers: { ...bearer(token), ...JSON_TYPE },
      body: JSON.stringify({ name: "eve", role: "member" }),
    });
    assert.equal(write.status, 403);
  });
});

test("public paths reach routing with no credentials", async () => {
  await withApp(async ({ app }) => {
    // The real handlers answer (device/start succeeds, the others reject the empty body), never with the auth layer's "missing bearer token".
    for (const path of ["/v1/signin", "/v1/device/start", "/v1/device/poll"]) {
      const res = await app.request(path, { method: "POST", headers: JSON_TYPE, body: "{}" });
      assert.ok([200, 400, 401].includes(res.status), `${path} -> ${res.status}`);
      if (res.status !== 200) assert.notEqual((await errorOf(res)).message, "missing bearer token", path);
    }
    const other = await app.request("/v1/signin/x", { method: "POST", headers: JSON_TYPE, body: "{}" });
    assert.equal(other.status, 401);
  });
});

test("a listed approver answers an awaiting_approval block by cookie", async () => {
  await withApp(async ({ db, app }) => {
    const ada = await signIn(db, "ada", "member");
    await setRoom(db, "build", { approvers: ["ada"] });
    const bot = await agentAuth(db, "bot");
    const t = await createTask(db, bot, { room: "build", brief: "ship" });
    const c = await claimTask(db, bot, t.id);
    await block(db, bot, t.id, c.claimId, {
      question: "ship it?",
      kind: "awaiting_approval",
      options: ["approve", "reject"],
    });
    const body = JSON.stringify({ choice: "approve" });

    const forged = await app.request(`/v1/tasks/${t.id}/answer`, {
      method: "POST",
      headers: { ...cookie(ada.secret), "content-type": "text/plain" },
      body,
    });
    assert.equal(forged.status, 400);

    const res = await app.request(`/v1/tasks/${t.id}/answer`, {
      method: "POST",
      headers: { ...cookie(ada.secret), ...JSON_TYPE },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { task: { state: string } }).task.state, "ready");
  });
});

/** Reads a response body chunk by chunk; null once it ends. A read that times out stays pending for the next call. */
function chunkReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let pending: Promise<{ done: boolean; value?: Uint8Array }> | null = null;
  return async function next(timeoutMs: number): Promise<string | null> {
    pending ??= reader.read();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
    });
    try {
      const r = await Promise.race([pending, timeout]);
      if (r === "timeout") throw new Error("timed out waiting for the stream");
      pending = null;
      return r.done ? null : decoder.decode(r.value, { stream: true });
    } finally {
      clearTimeout(timer);
    }
  };
}

for (const end of ["revoked", "expired"] as const) {
  test(`a cookie stream outlives its pings and ends within 1 s once the session is ${end}`, async () => {
    await withApp(
      async ({ db, app }) => {
        const ada = await signIn(db, "ada");
        const ac = new AbortController();
        try {
          const res = await app.request("/v1/events/stream?after=0", { headers: cookie(ada.secret), signal: ac.signal });
          assert.equal(res.status, 200);
          const next = chunkReader(res);
          let seen = "";
          const deadline = Date.now() + 3000;
          while (seen.split(": ping\n\n").length - 1 < 4) {
            const chunk = await next(deadline - Date.now());
            assert.notEqual(chunk, null, "the stream ended before its fourth ping");
            seen += chunk;
          }

          if (end === "revoked") await revokeSession(db, ada.secret);
          else {
            await db`update sessions set expires_at = clock_timestamp() where hash = ${hashToken(ada.secret)}`;
          }
          const t0 = Date.now();
          while ((await next(1000 - (Date.now() - t0))) !== null);
          assert.ok(Date.now() - t0 < 1000, `ended ${Date.now() - t0} ms after the session was ${end}`);
        } finally {
          ac.abort();
        }
      },
      { streamPingMs: 100 },
    );
  });
}

test("requireAdmin: admin sessions and admins' admin-scope tokens pass; members and agents do not", async () => {
  await withTestDb(async (db) => {
    const admin = await personAuth(db, "ada", "admin");
    const member = await personAuth(db, "bob", "member");
    const bot = await agentAuth(db, "bot");
    const forbidden = { code: "forbidden", message: "admins only" };

    requireAdmin(admin);
    requireAdmin({ actor: admin.actor, via: "token", scope: "admin", role: "admin" });

    assert.throws(() => requireAdmin(member), forbidden);
    assert.throws(() => requireAdmin({ actor: member.actor, via: "token", scope: "admin", role: "member" }), forbidden);
    assert.throws(() => requireAdmin(bot), forbidden);
    assert.throws(() => requireAdmin({ ...bot, role: "admin" }), forbidden);
  });
});
