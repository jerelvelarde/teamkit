import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createClient, type TeamkitClient } from "@copilotkit/teamkit-client";
import { reapExpired } from "../../../apps/server/src/store/reaper.js";
import { agentToken, startTestServer } from "../../../apps/server/test/helpers/server.js";
import { runTask, type RunTarget, type RunTaskOptions } from "../src/run.js";
import { isolatedEnv, runCli, spawnCli } from "./helpers/cli.js";

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const LEASE_BEFORE = process.env.TEAMKIT_LEASE_MS;
afterEach(() => {
  if (LEASE_BEFORE === undefined) delete process.env.TEAMKIT_LEASE_MS;
  else process.env.TEAMKIT_LEASE_MS = LEASE_BEFORE;
});

interface Setup {
  srv: Awaited<ReturnType<typeof startTestServer>>;
  token: string;
  client: TeamkitClient;
  env: NodeJS.ProcessEnv;
}

async function withServer(fn: (s: Setup) => Promise<void>): Promise<void> {
  const srv = await startTestServer();
  try {
    const token = await agentToken(srv.db, "bot");
    const client = createClient({ url: srv.url, token });
    const env = isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: token });
    await fn({ srv, token, client, env });
  } finally {
    await srv.stop();
  }
}

function run(
  s: Setup,
  target: RunTarget,
  agent: string,
  logs: string[],
  extra: Partial<RunTaskOptions> & { agentEnv?: Record<string, string> } = {},
): Promise<number> {
  const { agentEnv, ...rest } = extra;
  return runTask({
    client: s.client,
    url: s.srv.url,
    token: s.token,
    target,
    command: [process.execPath, fixture(agent)],
    env: { ...s.env, ...agentEnv },
    log: (line) => logs.push(line),
    handleSignals: false,
    ...rest,
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(25);
  }
}

test("agent-ok completes the task and returns 0; signal listeners are removed", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "ok" });
    const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
    const logs: string[] = [];
    assert.equal(await run(s, { room: "build", waitMs: 0 }, "agent-ok.mjs", logs, { handleSignals: true }), 0);
    assert.deepEqual({ int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") }, before);
    const task = (await s.client.thread(t.id)).task;
    assert.equal(task?.state, "completed");
    assert.equal(task?.result, "agent exited 0");
  });
});

test("agent-fail fails the task with the exit code and returns 1", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "fail" });
    assert.equal(await run(s, { taskId: t.id }, "agent-fail.mjs", []), 1);
    assert.equal((await s.client.thread(t.id)).task?.state, "failed");
    const { events } = await s.client.events({ thread: t.id, kinds: ["task.failed"] });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.data.reason, "agent exited with code 2");
  });
});

test("agent-block leaves the task blocked and returns 0", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "pick a db" });
    assert.equal(await run(s, { taskId: t.id }, "agent-block.mjs", []), 0);
    const task = (await s.client.thread(t.id)).task;
    assert.equal(task?.state, "blocked");
    assert.equal(task?.block?.question, "which db?");
    assert.deepEqual(task?.block?.options, ["pg", "sqlite"]);
  });
});

test("renewing keeps a short lease alive while the agent runs", async () => {
  await withServer(async (s) => {
    process.env.TEAMKIT_LEASE_MS = "1000";
    const t = await s.client.createTask({ room: "build", brief: "slow" });
    const started = Date.now();
    const running = run(s, { taskId: t.id }, "agent-slow.mjs", [], {
      renewEveryMs: 200,
      agentEnv: { AGENT_SLOW_MS: "2500" },
    });
    const claimId = await waitFor(async () => (await s.client.thread(t.id)).task?.claim?.id);
    await sleep(Math.max(0, 2000 - (Date.now() - started)));
    assert.equal(await reapExpired(s.srv.db), 0);
    assert.equal((await s.client.thread(t.id)).task?.claim?.id, claimId);
    assert.equal(await running, 0);
    assert.equal((await s.client.thread(t.id)).task?.state, "completed");
  });
});

test("a lost claim stops the agent and returns 1 without settling the task", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "slow" });
    const logs: string[] = [];
    const running = run(s, { taskId: t.id }, "agent-slow.mjs", logs, { renewEveryMs: 200 });
    await waitFor(async () => (await s.client.thread(t.id)).task?.claim?.id);
    await sleep(300);

    assert.equal(await reapExpired(s.srv.db, new Date(Date.now() + 10 * 60_000)), 1);
    const other = createClient({ url: s.srv.url, token: await agentToken(s.srv.db, "bot2") });
    const second = await other.claim(t.id);
    const lostAt = Date.now();
    assert.equal(await running, 1);
    assert.ok(Date.now() - lostAt < 5000, `run took ${Date.now() - lostAt} ms to stop`);

    const task = (await s.client.thread(t.id)).task;
    assert.equal(task?.state, "claimed");
    assert.equal(task?.claim?.id, second.claimId);
    assert.ok(logs.some((l) => /claim lost/.test(l)), logs.join("\n"));
  });
});

test("a command that cannot start releases the claim and returns 1", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "x" });
    const logs: string[] = [];
    const code = await runTask({
      client: s.client,
      url: s.srv.url,
      token: s.token,
      target: { taskId: t.id },
      command: ["/nonexistent/teamkit-agent"],
      env: s.env,
      log: (line) => logs.push(line),
      handleSignals: false,
    });
    assert.equal(code, 1);
    assert.equal((await s.client.thread(t.id)).task?.state, "ready");
    assert.ok(logs.some((l) => /ENOENT/.test(l)), logs.join("\n"));
  });
});

test("SIGINT to the bin stops the agent, releases the claim and exits 130", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "slow" });
    const child = spawnCli(["run", t.id, "--", "node", fixture("agent-slow.mjs")], s.env);
    try {
      let out = "";
      let err = "";
      child.stdout?.setEncoding("utf8").on("data", (d: string) => (out += d));
      child.stderr?.setEncoding("utf8").on("data", (d: string) => (err += d));
      const closed = once(child, "close");
      await waitFor(() => (out.includes("started") ? true : undefined), 20_000);
      child.kill("SIGINT");
      const [code] = (await closed) as [number | null];
      assert.equal(code, 130, err);
      assert.equal((await s.client.thread(t.id)).task?.state, "ready");
    } finally {
      child.kill("SIGKILL");
    }
  });
});

test("SIGINT while waiting for a ready task exits 130", async () => {
  await withServer(async (s) => {
    const child = spawnCli(["run", "--ready", "empty", "--wait", "30s", "--", "node", fixture("agent-ok.mjs")], s.env);
    try {
      let err = "";
      child.stderr?.setEncoding("utf8").on("data", (d: string) => (err += d));
      const closed = once(child, "close");
      await waitFor(() => (err.includes("looking for a ready task in empty") ? true : undefined), 20_000);
      const sentAt = Date.now();
      child.kill("SIGINT");
      const [code] = (await closed) as [number | null];
      assert.equal(code, 130, err);
      assert.ok(Date.now() - sentAt < 5000);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

test("run --ready on an empty room exits 3 after the wait", async () => {
  await withServer(async (s) => {
    const r = await runCli(["run", "--ready", "empty", "--wait", "1s", "--", "node", fixture("agent-ok.mjs")], s.env);
    assert.equal(r.code, 3, r.stderr);
  });
});

test("run --ready --label skips an older task with another label", async () => {
  await withServer(async (s) => {
    const reviewer = await s.client.createTask({ room: "build", brief: "review", labels: { role: "reviewer" } });
    const worker = await s.client.createTask({ room: "build", brief: "work", labels: { role: "worker" } });
    const r = await runCli(
      ["run", "--ready", "build", "--label", "role=worker", "--", "node", fixture("agent-ok.mjs")],
      s.env,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal((await s.client.thread(worker.id)).task?.state, "completed");
    assert.equal((await s.client.thread(reviewer.id)).task?.state, "ready");
  });
});

test("run without a command is a usage error and claims nothing", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "x" });
    assert.equal((await runCli(["run", t.id], s.env)).code, 2);
    assert.equal((await runCli(["run", "--ready", "build"], s.env)).code, 2);
    assert.equal((await runCli(["run", t.id, "--label", "a=b", "--", "node", fixture("agent-ok.mjs")], s.env)).code, 2);
    assert.equal((await s.client.thread(t.id)).task?.state, "ready");
  });
});
