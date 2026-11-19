import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import type { Db } from "../src/db/pool.js";
import { withTestDb } from "./helpers/db.js";
import { createNotifier } from "../src/notifier.js";
import { createApp, type AppOptions } from "../src/http/app.js";
import { createJoinLink, redeemJoinLink } from "../src/store/join.js";
import type { MailMessage, Mailer } from "../src/mail.js";
import { smtpMailer } from "../src/mail-smtp.js";

type App = ReturnType<typeof createApp>;

async function withApp(
  fn: (ctx: { db: Db; app: App }) => Promise<void>,
  deps: { mailer?: Mailer } = {},
  opts?: AppOptions,
): Promise<void> {
  await withTestDb(async (db) => {
    const notifier = await createNotifier(db);
    try {
      await fn({ db, app: createApp({ db, notifier, mailer: deps.mailer }, opts) });
    } finally {
      await notifier.close();
    }
  });
}

const JSON_TYPE = { "content-type": "application/json" };
const post = (app: App, path: string, body: unknown, headers: Record<string, string> = JSON_TYPE) =>
  app.request(path, { method: "POST", headers, body: JSON.stringify(body) });

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

function fakeMailer(fail = false) {
  const sent: MailMessage[] = [];
  const mailer: Mailer = { send: async (m) => { sent.push(m); if (fail) throw new Error("smtp down"); } };
  return { sent, mailer };
}
const joinAna = async (db: Db) =>
  redeemJoinLink(db, { code: (await createJoinLink(db, { createdBy: null })).secret, name: "ana", email: "ana@example.com" });

test("a known email gets a one-time link that signs the person in", async () => {
  const { sent, mailer } = fakeMailer();
  await withApp(async ({ db, app }) => {
    await joinAna(db);
    const res = await post(app, "/v1/signin/email", { email: "Ana@Example.com" });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, "ana@example.com");
    assert.equal(sent[0]!.subject, "Your AG-UI TeamKit sign-in link");
    const secret = /http:\/\/127\.0\.0\.1:3000\/signin\/(sl_\S+)/.exec(sent[0]!.text)?.[1];
    assert.ok(secret, sent[0]!.text);
    const signin = await post(app, "/v1/signin", { token: secret });
    assert.equal(((await signin.json()) as { actor: { name: string } }).actor.name, "ana");
  }, { mailer });
});

test("an unknown email gets the same answer and no email", async () => {
  const { sent, mailer } = fakeMailer();
  await withApp(async ({ app }) => {
    const res = await post(app, "/v1/signin/email", { email: "nobody@example.com" });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(sent.length, 0);
  }, { mailer });
});

test("one email per person a minute", async () => {
  const { sent, mailer } = fakeMailer();
  await withApp(async ({ db, app }) => {
    await joinAna(db);
    for (let i = 0; i < 2; i++) assert.equal((await post(app, "/v1/signin/email", { email: "ana@example.com" })).status, 202);
    assert.equal(sent.length, 1);
    await db`update signin_links set created_at = clock_timestamp() - interval '2 minutes'`;
    await post(app, "/v1/signin/email", { email: "ana@example.com" });
    assert.equal(sent.length, 2);
  }, { mailer });
});

test("emailed links work for 30 minutes", async () => {
  const { mailer } = fakeMailer();
  await withApp(async ({ db, app }) => {
    await joinAna(db);
    await post(app, "/v1/signin/email", { email: "ana@example.com" });
    const [r] = await db`select extract(epoch from expires_at - created_at)::float8 as s from signin_links`;
    assert.ok(Math.abs((r!.s as number) - 1800) < 2);
  }, { mailer });
});

test("without a mailer the route says so; a bad email or a non-JSON post is invalid_input", async () => {
  await withApp(async ({ app }) => {
    const res = await post(app, "/v1/signin/email", { email: "ana@example.com" });
    assert.equal(res.status, 409);
    assert.deepEqual(await errorOf(res), { code: "invalid_state", message: "this server cannot send email; ask an admin for a sign-in link" });
  });
  const { mailer } = fakeMailer();
  await withApp(async ({ app }) => {
    assert.equal((await post(app, "/v1/signin/email", { email: "ana" })).status, 400);
    assert.equal((await post(app, "/v1/signin/email", { email: "ana@example.com" }, { "content-type": "text/plain" })).status, 400);
  }, { mailer });
});

test("a failing mailer still answers 202", async () => {
  const { sent, mailer } = fakeMailer(true);
  await withApp(async ({ db, app }) => {
    await joinAna(db);
    assert.equal((await post(app, "/v1/signin/email", { email: "ana@example.com" })).status, 202);
    assert.equal(sent.length, 1);
  }, { mailer });
});

test("smtpMailer reports a refused connection", async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  const m = smtpMailer({ url: `smtp://127.0.0.1:${port}`, from: "AG-UI TeamKit <teamkit@example.com>" });
  await assert.rejects(m.send({ to: "ana@example.com", subject: "s", text: "t" }), /ECONNREFUSED/);
});
