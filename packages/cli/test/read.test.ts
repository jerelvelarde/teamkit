import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createClient } from "@copilotkit/teamkit-client";
import { agentToken, startTestServer } from "../../../apps/server/test/helpers/server.js";
import { isolatedEnv, runCli } from "./helpers/cli.js";

let server: Awaited<ReturnType<typeof startTestServer>>;
let env: NodeJS.ProcessEnv;
let threadId: string;
let cursorAfterFirst: string;

before(async () => {
  server = await startTestServer();
  const token = await agentToken(server.db, "worker-1");
  env = isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_TOKEN: token });
  const client = createClient({ url: server.url, token });
  threadId = (await client.post("build", "first post")).threadId;
  cursorAfterFirst = (await client.thread(threadId)).cursor;
  await client.reply(threadId, "second message");
});

after(async () => {
  await server.stop();
});

test("reading a room shows a posted thread", async () => {
  const r = await runCli(["read", "build"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^build\n/);
  assert.ok(r.stdout.includes(threadId));
});

test("read <thread> --json includes the messages", async () => {
  const r = await runCli(["read", threadId, "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  const view = JSON.parse(r.stdout);
  assert.equal(view.thread.id, threadId);
  assert.equal(view.messages.length, 2);
  assert.match(JSON.stringify(view.messages), /first post/);
});

test("read <thread> prints a formatted thread", async () => {
  const r = await runCli(["read", threadId], env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("second message"));
});

test("--after filters thread events", async () => {
  const all = await runCli(["read", threadId, "--after", "0", "--json"], env);
  const later = await runCli(["read", threadId, "--after", cursorAfterFirst, "--json"], env);
  assert.equal(all.code, 0, all.stderr);
  assert.equal(later.code, 0, later.stderr);
  const allOut = JSON.parse(all.stdout);
  const laterOut = JSON.parse(later.stdout);
  assert.ok(allOut.events.length > laterOut.events.length);
  assert.ok(laterOut.events.every((e: { kind: string }) => e.kind === "message.posted"));
  assert.equal(laterOut.events.length, 1);
  assert.equal(typeof laterOut.cursor, "string");
  const text = await runCli(["read", threadId, "--after", cursorAfterFirst], env);
  assert.match(text.stdout, /message\.posted/);
});

test("an unknown room exits 1 with not_found", async () => {
  const r = await runCli(["read", "no-such-room"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not_found/);
});
