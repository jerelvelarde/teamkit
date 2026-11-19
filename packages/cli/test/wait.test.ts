import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createClient, type TeamkitClient } from "@copilotkit/teamkit-client";
import { agentToken, startTestServer } from "../../../apps/server/test/helpers/server.js";
import { isolatedEnv, runCli, spawnCli } from "./helpers/cli.js";

let srv: Awaited<ReturnType<typeof startTestServer>>;
let client: TeamkitClient;
let env: NodeJS.ProcessEnv;

before(async () => {
  srv = await startTestServer();
  const token = await agentToken(srv.db, "waiter");
  client = createClient({ url: srv.url, token });
  env = isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: token });
});
after(async () => {
  await srv.stop();
});

async function runWaiter(args: string[]) {
  const child = spawnCli(args, env);
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const done = new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
  // Give the stream time to open.
  await new Promise((r) => setTimeout(r, 1000));
  return { child, done, out: () => stdout, err: () => stderr };
}

async function completeTask(room: string, brief: string, labels?: Record<string, string>) {
  const t = await client.createTask({ room, brief, ...(labels ? { labels } : {}) });
  const c = await client.claim(t.id);
  await client.complete(t.id, c.claimId, "done");
  return t;
}

test("wait prints the matching event as JSON and exits 0", async () => {
  const cursor = (await client.events({ room: "build" })).cursor;
  const w = await runWaiter(["wait", "build", "--kind", "task.completed", "--after", cursor, "--json", "--timeout", "20s"]);
  const t = await completeTask("build", "x");
  assert.equal(await w.done, 0, w.err());
  const ev = JSON.parse(w.out().trim().split("\n")[0]!);
  assert.equal(ev.kind, "task.completed");
  assert.equal(ev.threadId, t.id);
});

test("--timeout ends the wait with exit 3 while the stream is idle", async () => {
  const start = Date.now();
  const r = await runCli(["wait", "quiet", "--timeout", "1s"], env, { timeoutMs: 10000 });
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /timed out/);
  assert.ok(Date.now() - start < 3000, `took ${Date.now() - start}ms`);
});

test("--label ignores a non-matching task's completion", async () => {
  const w = await runWaiter(["wait", "lab", "--kind", "task.completed", "--label", "team=a", "--json", "--timeout", "20s"]);
  const other = await completeTask("lab", "other", { team: "b" });
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(w.out(), "", "non-matching event must not print");
  const match = await completeTask("lab", "match", { team: "a" });
  assert.equal(await w.done, 0, w.err());
  const ev = JSON.parse(w.out().trim());
  assert.equal(ev.threadId, match.id);
  assert.notEqual(ev.threadId, other.id);
});

test("a bad --kind is a usage error", async () => {
  const r = await runCli(["wait", "build", "--kind", "nope"], env);
  assert.equal(r.code, 2);
});
