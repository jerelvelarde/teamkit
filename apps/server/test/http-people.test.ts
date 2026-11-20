import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db/pool.js";
import { withTestDb } from "./helpers/db.js";
import { createNotifier } from "../src/notifier.js";
import { createApp, type AppOptions } from "../src/http/app.js";
import { invitePerson } from "../src/store/people.js";
import { agentAuth } from "./helpers/actors.js";

type App = ReturnType<typeof createApp>;

async function withApp(
  fn: (ctx: { db: Db; app: App }) => Promise<void>,
  publicUrl?: string,
  opts?: AppOptions,
): Promise<void> {
  await withTestDb(async (db) => {
    const notifier = await createNotifier(db);
    try {
      await fn({ db, app: createApp({ db, notifier, publicUrl }, opts) });
    } finally {
      await notifier.close();
    }
  });
}

const JSON_TYPE = { "content-type": "application/json" };
const post = (app: App, path: string, body: unknown, headers: Record<string, string> = JSON_TYPE) =>
  app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
const cookieOf = (res: Response): string => {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0]!;
};

test("a sign-in link works once and sets a hardened session cookie", async () => {
  await withApp(async ({ db, app }) => {
    const invite = await invitePerson(db, { name: "ada", role: "admin" });
    const res = await post(app, "/v1/signin", { token: invite.secret });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { actor: invite.person, role: "admin" });
    const set = res.headers.get("set-cookie") ?? "";
    assert.match(set, /^teamkit_session=ts_/);
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Lax/i);
    assert.match(set, /Path=\//);
    assert.match(set, /Max-Age=2592000/i);
    assert.doesNotMatch(set, /Secure/i);

    const again = await post(app, "/v1/signin", { token: invite.secret });
    assert.equal(again.status, 401);
  });
});

test("over https the cookie is __Host-teamkit_session: Secure, Path=/, no Domain", async () => {
  await withApp(async ({ db, app }) => {
    const invite = await invitePerson(db, { name: "ada", role: "admin" });
    const res = await post(app, "/v1/signin", { token: invite.secret });
    const set = res.headers.get("set-cookie") ?? "";
    assert.match(set, /^__Host-teamkit_session=ts_/);
    assert.match(set, /; Secure/i);
    assert.match(set, /; Path=\/(;|$)/);
    assert.doesNotMatch(set, /Domain=/i);
    const secret = cookieOf(res).split("=")[1]!;

    // Only the __Host- name is read: a plain-named cookie (which a sibling subdomain could set) is ignored.
    assert.equal((await app.request("/v1/whoami", { headers: { cookie: `teamkit_session=${secret}` } })).status, 401);
    const cookie = `__Host-teamkit_session=${secret}`;
    assert.equal((await app.request("/v1/whoami", { headers: { cookie } })).status, 200);

    const out = await post(app, "/v1/logout", {}, { ...JSON_TYPE, cookie });
    assert.equal(out.status, 200);
    const cleared = out.headers.get("set-cookie") ?? "";
    assert.match(cleared, /^__Host-teamkit_session=;/);
    assert.match(cleared, /Max-Age=0/i);
    assert.match(cleared, /; Secure/i);
  }, "https://b.example");
});

test("sign-in refuses anything but application/json (login CSRF)", async () => {
  await withApp(async ({ db, app }) => {
    const invite = await invitePerson(db, { name: "ada", role: "admin" });
    const body = JSON.stringify({ token: invite.secret });
    for (const type of [
      "application/x-www-form-urlencoded",
      "text/plain",
      "multipart/form-data; boundary=x",
      "application/jsonp",
      "text/plain; application/json",
      undefined,
    ]) {
      const headers: Record<string, string> = type ? { "content-type": type } : {};
      const res = await app.request("/v1/signin", { method: "POST", headers, body });
      assert.equal(res.status, 400, String(type));
      assert.equal(res.headers.get("set-cookie"), null);
    }
    // The refused attempts did not burn the link; parameters and case are fine.
    const ok = await app.request("/v1/signin", {
      method: "POST",
      headers: { "content-type": "Application/JSON; charset=utf-8" },
      body,
    });
    assert.equal(ok.status, 200);
  });
});

test("the session authenticates whoami; logout clears the cookie and revokes it server-side", async () => {
  await withApp(async ({ db, app }) => {
    const invite = await invitePerson(db, { name: "ada", role: "admin" });
    const cookie = cookieOf(await post(app, "/v1/signin", { token: invite.secret }));
    assert.equal((await app.request("/v1/whoami", { headers: { cookie } })).status, 200);

    const out = await post(app, "/v1/logout", {}, { ...JSON_TYPE, cookie });
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), { ok: true });
    const cleared = out.headers.get("set-cookie") ?? "";
    assert.match(cleared, /^teamkit_session=;/);
    assert.match(cleared, /Max-Age=0/i);
    assert.match(cleared, /Path=\//);

    // The old secret is dead even if a client keeps sending it.
    assert.equal((await app.request("/v1/whoami", { headers: { cookie } })).status, 401);
  });
});

test("device login end to end, then logout revokes the admin token", async () => {
  await withApp(async ({ db, app }) => {
    const invite = await invitePerson(db, { name: "ada", role: "admin" });
    const cookie = cookieOf(await post(app, "/v1/signin", { token: invite.secret }));

    const startRes = await post(app, "/v1/device/start", {}, {});
    assert.equal(startRes.status, 200);
    const start = (await startRes.json()) as { deviceCode: string; userCode: string; verifyUrl: string; intervalMs: number };
    assert.equal(start.verifyUrl, `http://127.0.0.1:3000/device?code=${start.userCode}`);
    assert.equal(typeof start.intervalMs, "number");

    const pending = await post(app, "/v1/device/poll", { deviceCode: start.deviceCode });
    assert.deepEqual(await pending.json(), { status: "pending" });

    const approve = await post(app, "/v1/device/approve", { userCode: start.userCode }, { ...JSON_TYPE, cookie });
    assert.equal(approve.status, 200);
    assert.deepEqual(await approve.json(), { ok: true });

    const done = (await (await post(app, "/v1/device/poll", { deviceCode: start.deviceCode })).json()) as {
      status: string;
      token: string;
    };
    assert.equal(done.status, "approved");
    assert.match(done.token, /^tk_/);

    const bearer = { authorization: `Bearer ${done.token}` };
    const who = (await (await app.request("/v1/whoami", { headers: bearer })).json()) as { scope: string };
    assert.equal(who.scope, "admin");

    assert.deepEqual(await (await post(app, "/v1/device/poll", { deviceCode: start.deviceCode })).json(), {
      status: "expired",
    });

    const out = await app.request("/v1/logout", { method: "POST", headers: bearer });
    assert.equal(out.status, 200);
    assert.equal((await app.request("/v1/whoami", { headers: bearer })).status, 401);
  });
});

test("device approve needs a session person, not a token", async () => {
  await withApp(async ({ db, app }) => {
    const agent = await agentAuth(db, "bot");
    const start = (await (await post(app, "/v1/device/start", {}, {})).json()) as { userCode: string };

    const asAgent = await post(app, "/v1/device/approve", { userCode: start.userCode }, {
      ...JSON_TYPE,
      authorization: `Bearer ${agent.token}`,
    });
    assert.equal(asAgent.status, 403);

    const anon = await post(app, "/v1/device/approve", { userCode: start.userCode });
    assert.equal(anon.status, 401);

    // A person's admin-scope token (from an earlier device login) cannot approve another login.
    const invite = await invitePerson(db, { name: "ada", role: "admin" });
    const cookie = cookieOf(await post(app, "/v1/signin", { token: invite.secret }));
    const first = (await (await post(app, "/v1/device/start", {}, {})).json()) as { deviceCode: string; userCode: string };
    await post(app, "/v1/device/approve", { userCode: first.userCode }, { ...JSON_TYPE, cookie });
    const tok = ((await (await post(app, "/v1/device/poll", { deviceCode: first.deviceCode })).json()) as { token: string }).token;
    const viaAdminToken = await post(app, "/v1/device/approve", { userCode: start.userCode }, {
      ...JSON_TYPE,
      authorization: `Bearer ${tok}`,
    });
    assert.equal(viaAdminToken.status, 403);
  });
});

test("logout with an agent token is forbidden", async () => {
  await withApp(async ({ db, app }) => {
    const agent = await agentAuth(db, "bot");
    const res = await app.request("/v1/logout", { method: "POST", headers: { authorization: `Bearer ${agent.token}` } });
    assert.equal(res.status, 403);
  });
});

test("device/start allows a burst per client address, then answers 429 with Retry-After", async () => {
  await withApp(
    async ({ app }) => {
      const from = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
      const start = (address: string) =>
        app.request("/v1/device/start", { method: "POST", headers: JSON_TYPE, body: "{}" }, from(address));
      for (let i = 0; i < 3; i++) assert.equal((await start("10.0.0.1")).status, 200, `request ${i + 1}`);
      const limited = await start("10.0.0.1");
      assert.equal(limited.status, 429);
      assert.equal(((await limited.json()) as { error: { code: string } }).error.code, "rate_limited");
      const retryAfter = Number(limited.headers.get("retry-after"));
      assert.ok(retryAfter >= 1 && retryAfter <= 60, `retry-after ${retryAfter}`);
      // Another address has its own budget.
      assert.equal((await start("10.0.0.2")).status, 200);
    },
    undefined,
    { deviceStartLimit: { burst: 3, perMinute: 1 } },
  );
});

test("device/start ignores X-Forwarded-For by default: every client behind the socket shares one budget", async () => {
  await withApp(
    async ({ app }) => {
      const env = { incoming: { socket: { remoteAddress: "10.0.0.1" } } };
      const start = (xff: string) =>
        app.request("/v1/device/start", { method: "POST", headers: { ...JSON_TYPE, "x-forwarded-for": xff }, body: "{}" }, env);
      assert.equal((await start("1.1.1.1")).status, 200);
      assert.equal((await start("2.2.2.2")).status, 200);
      assert.equal((await start("3.3.3.3")).status, 429);
    },
    undefined,
    { deviceStartLimit: { burst: 2, perMinute: 1 } },
  );
});

test("with trustedProxy, device/start keys on the first X-Forwarded-For address and falls back to the socket", async () => {
  await withApp(
    async ({ app }) => {
      const env = { incoming: { socket: { remoteAddress: "10.0.0.1" } } };
      const start = (xff?: string) =>
        app.request(
          "/v1/device/start",
          { method: "POST", headers: { ...JSON_TYPE, ...(xff ? { "x-forwarded-for": xff } : {}) }, body: "{}" },
          env,
        );
      assert.equal((await start("1.1.1.1, 10.0.0.9")).status, 200);
      assert.equal((await start("1.1.1.1, 10.9.9.9")).status, 200);
      assert.equal((await start("1.1.1.1")).status, 429);
      // A different client behind the same proxy has its own budget.
      assert.equal((await start("2.2.2.2")).status, 200);
      // No header: the socket address is the key.
      assert.equal((await start()).status, 200);
      assert.equal((await start()).status, 200);
      assert.equal((await start()).status, 429);
    },
    undefined,
    { deviceStartLimit: { burst: 2, perMinute: 1 }, trustedProxy: true },
  );
});

test("device/start in agent mode puts mode=agent in the verify url; a bad mode is invalid_input", async () => {
  await withApp(async ({ app }) => {
    const agent = (await (await post(app, "/v1/device/start", { mode: "agent" }, {})).json()) as { userCode: string; verifyUrl: string };
    assert.equal(agent.verifyUrl, `http://127.0.0.1:3000/device?code=${agent.userCode}&mode=agent`);
    const admin = (await (await post(app, "/v1/device/start", {}, {})).json()) as { userCode: string; verifyUrl: string };
    assert.equal(admin.verifyUrl, `http://127.0.0.1:3000/device?code=${admin.userCode}`);
    const bad = await post(app, "/v1/device/start", { mode: "root" }, {});
    assert.equal(bad.status, 400);
  });
});

test("device approve in agent mode takes rooms and answers with the agent", async () => {
  await withApp(async ({ db, app }) => {
    const invite = await invitePerson(db, { name: "ana", role: "member" });
    const cookie = cookieOf(await post(app, "/v1/signin", { token: invite.secret }));
    const start = (await (await post(app, "/v1/device/start", { mode: "agent" }, {})).json()) as { deviceCode: string; userCode: string };
    const notArray = await post(app, "/v1/device/approve", { userCode: start.userCode, rooms: "billing-migration" }, { ...JSON_TYPE, cookie });
    assert.equal(notArray.status, 400);
    const ok = await post(app, "/v1/device/approve", { userCode: start.userCode, rooms: ["billing-migration"] }, { ...JSON_TYPE, cookie });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { ok: boolean; agent: { name: string; kind: string } };
    assert.deepEqual([body.ok, body.agent.name, body.agent.kind], [true, "ana-agent", "agent"]);
    const done = (await (await post(app, "/v1/device/poll", { deviceCode: start.deviceCode })).json()) as { token: string };
    const who = (await (await app.request("/v1/whoami", { headers: { authorization: `Bearer ${done.token}` } })).json()) as { scope: string };
    assert.equal(who.scope, "agent");
  });
});
