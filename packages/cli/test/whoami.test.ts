import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createClient } from "@copilotkit/teamkit-client";
import { agentToken, startTestServer } from "../../../apps/server/test/helpers/server.js";
import { isolatedEnv, runCli } from "./helpers/cli.js";

let server: Awaited<ReturnType<typeof startTestServer>>;
let token: string;

before(async () => {
  server = await startTestServer();
  token = await agentToken(server.db, "worker-1");
});
after(async () => {
  await server.stop();
});

test("whoami --json shows worker-1", async () => {
  const r = await runCli(["whoami", "--json"], isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_TOKEN: token }));
  assert.equal(r.code, 0, r.stderr);
  const who = JSON.parse(r.stdout.trim());
  assert.equal(who.actor.name, "worker-1");
  assert.equal(who.actor.kind, "agent");
  assert.equal(who.scope, "agent");
});

test("whoami prints name, kind and scope", async () => {
  const r = await runCli(["whoami"], isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_TOKEN: token }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /worker-1 \(agent\)/);
  assert.match(r.stdout, /scope: agent/);
});

test("rooms lists build after a post", async () => {
  await createClient({ url: server.url, token }).post("build", "hello");
  const env = isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_TOKEN: token });
  const r = await runCli(["rooms"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.split("\n").includes("build"), r.stdout);
  const j = await runCli(["rooms", "--json"], env);
  assert.ok((JSON.parse(j.stdout.trim()) as { name: string }[]).some((x) => x.name === "build"));
});

test("no TEAMKIT_TOKEN exits 2", async () => {
  const r = await runCli(["whoami"], isolatedEnv({ TEAMKIT_URL: server.url }));
  assert.equal(r.code, 2);
});

test("a bad token exits 1 with unauthorized", async () => {
  const r = await runCli(["whoami"], isolatedEnv({ TEAMKIT_URL: server.url, TEAMKIT_TOKEN: "nope" }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unauthorized/i);
});
