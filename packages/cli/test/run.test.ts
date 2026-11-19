import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createClient, TeamkitError, type TeamkitClient } from "@copilotkit/teamkit-client";
import { reapExpired } from "../../../apps/server/src/store/reaper.js";
import { agentToken, startTestServer } from "../../../apps/server/test/helpers/server.js";
import { EXIT_AGENT_NOT_STARTED, FALLBACK_RESULT, runTask, type RunTarget, type RunTaskOptions } from "../src/run.js";
import { BIN, isolatedEnv, runCli, spawnCli } from "./helpers/cli.js";

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
  /** Everything `run` logged, and the stderr of every bin started with `watch`. */
  logs: string[];
}

/** Runs `fn` against a fresh server; a failure carries the run log in its message. */
async function withServer(fn: (s: Setup) => Promise<void>): Promise<void> {
  const srv = await startTestServer();
  const logs: string[] = [];
  try {
    const token = await agentToken(srv.db, "bot");
    const client = createClient({ url: srv.url, token });
    const env = isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: token });
    await fn({ srv, token, client, env, logs });
  } catch (e) {
    if (logs.length === 0) throw e;
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`${message}\n--- teamkit run log ---\n${logs.join("\n")}`, { cause: e });
  } finally {
    await srv.stop();
  }
}

function run(
  s: Setup,
  target: RunTarget,
  command: string | string[],
  extra: Partial<RunTaskOptions> & { agentEnv?: Record<string, string> } = {},
): Promise<number> {
  const { agentEnv, ...rest } = extra;
  return runTask({
    client: s.client,
    url: s.srv.url,
    token: s.token,
    target,
    command: typeof command === "string" ? [process.execPath, fixture(command)] : command,
    env: { ...s.env, ...agentEnv },
    log: (line) => s.logs.push(line),
    handleSignals: false,
    ...rest,
  });
}

/** Collects a started bin's stdout and stderr; stderr also goes to the run log. */
function watch(s: Setup, child: ChildProcess): { out: () => string; closed: Promise<unknown[]> } {
  let out = "";
  child.stdout?.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr?.setEncoding("utf8").on("data", (d: string) => s.logs.push(d.trimEnd()));
  return { out: () => out, closed: once(child, "close") };
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

/** Reaps the task's lease as if it ended long ago. A renew holding the row lock makes a reap skip it, so retry. */
async function reapNow(s: Setup): Promise<void> {
  const later = new Date(Date.now() + 10 * 60_000);
  await waitFor(async () => ((await reapExpired(s.srv.db, later)) === 1 ? true : undefined), 5000);
}

const tempFile = (name: string): string => join(mkdtempSync(join(tmpdir(), "teamkit-run-")), name);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readPid = (file: string): Promise<number> =>
  waitFor(() => (existsSync(file) && readFileSync(file, "utf8") !== "" ? Number(readFileSync(file, "utf8")) : undefined));
/** A shell that runs the slow agent as its child rather than exec-ing it. */
const compoundAgent = (): string[] => ["sh", "-c", `"${process.execPath}" "${fixture("agent-slow.mjs")}"; exit $?`];

/** A server that accepts connections and never answers. */
async function withStallServer(fn: (url: string) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  }
}

/** A fetch that sends the first request whose path matches `pattern` to `stallUrl`, and the rest on to `next`. */
function stallFirst(serverUrl: string, stallUrl: string, pattern: RegExp, next: typeof fetch = fetch): typeof fetch {
  let stalled = false;
  return (input, init) => {
    const url = String(input);
    if (stalled || !pattern.test(new URL(url).pathname)) return next(input, init);
    stalled = true;
    return fetch(url.replace(serverUrl, stallUrl), init);
  };
}

test("agent-ok completes the task with the fallback result and returns 0; signal listeners are removed", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "ok" });
    const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
    assert.equal(await run(s, { room: "build", waitMs: 0 }, "agent-ok.mjs", { handleSignals: true }), 0);
    assert.deepEqual({ int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") }, before);
    const task = (await s.client.thread(t.id)).task;
    assert.equal(task?.state, "completed");
    assert.equal(task?.result, FALLBACK_RESULT);
    assert.ok(s.logs.some((l) => /without completing/.test(l)), s.logs.join("\n"));
  });
});

test("agent-fail fails the task with the exit code and returns 1", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "fail" });
    assert.equal(await run(s, { taskId: t.id }, "agent-fail.mjs"), 1);
    assert.equal((await s.client.thread(t.id)).task?.state, "failed");
    const { events } = await s.client.events({ thread: t.id, kinds: ["task.failed"] });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.data.reason, "agent exited with code 2");
  });
});

test("agent-block leaves the task blocked and returns 0", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "pick a db" });
    assert.equal(await run(s, { taskId: t.id }, "agent-block.mjs"), 0);
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
    const running = run(s, { taskId: t.id }, "agent-slow.mjs", {
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

test("a renew that never gets an answer times out, and the next one starts on schedule", async () => {
  await withStallServer(async (stallUrl) => {
    await withServer(async (s) => {
      process.env.TEAMKIT_LEASE_MS = "1500";
      const t = await s.client.createTask({ room: "build", brief: "slow" });
      const renewStarts: number[] = [];
      const stallRenew = stallFirst(s.srv.url, stallUrl, /\/renew$/);
      const client = createClient({
        url: s.srv.url,
        token: s.token,
        timeoutMs: 800,
        fetch: (input, init) => {
          if (String(input).endsWith("/renew")) renewStarts.push(Date.now());
          return stallRenew(input, init);
        },
      });
      const started = Date.now();
      const running = run(s, { taskId: t.id }, "agent-slow.mjs", {
        client,
        renewEveryMs: 500,
        agentEnv: { AGENT_SLOW_MS: "2500" },
      });
      const claimId = await waitFor(async () => (await s.client.thread(t.id)).task?.claim?.id);
      // The first renew (at 500 ms) hangs until 1300 ms. The lease from the claim ends at 1500 ms;
      // the next renew must not wait another 500 ms after the timeout.
      await sleep(Math.max(0, 1700 - (Date.now() - started)));
      assert.equal(await reapExpired(s.srv.db), 0);
      assert.equal((await s.client.thread(t.id)).task?.claim?.id, claimId);
      assert.equal(await running, 0);
      assert.equal((await s.client.thread(t.id)).task?.state, "completed");
      assert.ok(s.logs.some((l) => /renew failed: timeout/.test(l)), s.logs.join("\n"));
      const gap = renewStarts[1]! - renewStarts[0]!;
      assert.ok(gap < 1100, `the renew after a timed-out one started ${gap} ms after it`);
    });
  });
});

test("settle calls that time out are retried: the task is still read and completed", async () => {
  await withStallServer(async (stallUrl) => {
    await withServer(async (s) => {
      const t = await s.client.createTask({ room: "build", brief: "ok" });
      const client = createClient({
        url: s.srv.url,
        token: s.token,
        timeoutMs: 300,
        fetch: stallFirst(s.srv.url, stallUrl, /\/threads\//, stallFirst(s.srv.url, stallUrl, /\/complete$/)),
      });
      assert.equal(await run(s, { taskId: t.id }, "agent-ok.mjs", { client, retryBackoffMs: 20 }), 0);
      assert.equal((await s.client.thread(t.id)).task?.state, "completed");
      assert.equal(s.logs.filter((l) => /failed \(timeout: .*retrying/.test(l)).length, 2, s.logs.join("\n"));
    });
  });
});

test("a settle call answered with a 4xx is not retried", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "ok" });
    let calls = 0;
    const client = createClient({
      url: s.srv.url,
      token: s.token,
      fetch: async (input, init) => {
        if (!/\/complete$/.test(String(input))) return fetch(input, init);
        calls++;
        return Response.json({ error: { code: "invalid_input", message: "no" } }, { status: 400 });
      },
    });
    await assert.rejects(
      run(s, { taskId: t.id }, "agent-ok.mjs", { client, retryBackoffMs: 20 }),
      (e: unknown) => e instanceof TeamkitError && e.code === "invalid_input",
    );
    assert.equal(calls, 1);
  });
});

test("a lost claim stops the agent and returns 1 without settling the task", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "slow" });
    const running = run(s, { taskId: t.id }, "agent-slow.mjs", { renewEveryMs: 200 });
    await waitFor(async () => (await s.client.thread(t.id)).task?.claim?.id);
    await sleep(300);

    await reapNow(s);
    const other = createClient({ url: s.srv.url, token: await agentToken(s.srv.db, "bot2") });
    const second = await other.claim(t.id);
    const lostAt = Date.now();
    assert.equal(await running, 1);
    assert.ok(Date.now() - lostAt < 5000, `run took ${Date.now() - lostAt} ms to stop`);

    const task = (await s.client.thread(t.id)).task;
    assert.equal(task?.state, "claimed");
    assert.equal(task?.claim?.id, second.claimId);
    assert.ok(s.logs.some((l) => /claim lost/.test(l)), s.logs.join("\n"));
  });
});

test("a lost claim stops every process of a compound sh -c agent", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "slow" });
    const pidFile = tempFile("pid");
    const running = run(s, { taskId: t.id }, compoundAgent(), { renewEveryMs: 200, agentEnv: { AGENT_PID_FILE: pidFile } });
    const pid = await readPid(pidFile);
    await reapNow(s);
    await createClient({ url: s.srv.url, token: await agentToken(s.srv.db, "bot2") }).claim(t.id);
    assert.equal(await running, 1);
    assert.equal(alive(pid), false, `agent ${pid} outlived run`);
  });
});

test("a command that cannot start releases the claim and returns 4", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "x" });
    assert.equal(await run(s, { taskId: t.id }, ["/nonexistent/teamkit-agent"]), EXIT_AGENT_NOT_STARTED);
    assert.equal((await s.client.thread(t.id)).task?.state, "ready");
    assert.ok(s.logs.some((l) => /ENOENT/.test(l)), s.logs.join("\n"));
  });
});

test("a shell exiting 127 (not found) or 126 (not executable) releases the task and returns 4", async () => {
  await withServer(async (s) => {
    const notExecutable = tempFile("agent.sh");
    writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n");
    chmodSync(notExecutable, 0o644);
    for (const cmd of ["teamkit-no-such-agent -p hello", `"${notExecutable}"`]) {
      const t = await s.client.createTask({ room: "build", brief: cmd });
      assert.equal(await run(s, { taskId: t.id }, ["sh", "-c", cmd]), EXIT_AGENT_NOT_STARTED, cmd);
      assert.equal((await s.client.thread(t.id)).task?.state, "ready", cmd);
      const { events } = await s.client.events({ thread: t.id, kinds: ["task.failed"] });
      assert.equal(events.length, 0, cmd);
    }
    assert.ok(s.logs.some((l) => /code 127: the agent command was not found/.test(l)), s.logs.join("\n"));
    assert.ok(s.logs.some((l) => /code 126: the agent command was not found/.test(l)), s.logs.join("\n"));
  });
});

test("SIGINT to the bin stops the agent, releases the claim and exits 130", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "slow" });
    const child = spawnCli(["run", t.id, "--", "node", fixture("agent-slow.mjs")], s.env);
    try {
      const w = watch(s, child);
      await waitFor(() => (w.out().includes("started") ? true : undefined), 20_000);
      child.kill("SIGINT");
      const [code] = (await w.closed) as [number | null];
      assert.equal(code, 130);
      assert.equal((await s.client.thread(t.id)).task?.state, "ready");
    } finally {
      child.kill("SIGKILL");
    }
  });
});

test("SIGTERM to the bin stops every process of a compound sh -c agent", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "slow" });
    const pidFile = tempFile("pid");
    const child = spawnCli(["run", t.id, "--", ...compoundAgent()], { ...s.env, AGENT_PID_FILE: pidFile });
    try {
      const w = watch(s, child);
      const pid = await readPid(pidFile);
      const sentAt = Date.now();
      child.kill("SIGTERM");
      // An agent left running holds the bin's stdout open, so close waits for it too.
      const [code] = (await w.closed) as [number | null];
      assert.equal(code, 130);
      assert.ok(Date.now() - sentAt < 5000, `run and its agent took ${Date.now() - sentAt} ms to stop`);
      assert.equal(alive(pid), false, `agent ${pid} outlived run`);
      assert.equal((await s.client.thread(t.id)).task?.state, "ready");
    } finally {
      child.kill("SIGKILL");
    }
  });
});

test("Ctrl-C to the terminal's process group reaches the agent once", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "slow" });
    const signalLog = tempFile("signals");
    // Its own process group, like a foreground job: a group SIGINT is what a terminal Ctrl-C sends.
    const child = spawn(process.execPath, [BIN, "run", t.id, "--", "node", fixture("agent-slow.mjs")], {
      env: { ...s.env, AGENT_SIGNAL_LOG: signalLog, AGENT_EXIT_DELAY_MS: "500" },
      stdio: "pipe",
      detached: true,
    });
    try {
      const w = watch(s, child);
      await waitFor(() => (w.out().includes("started") ? true : undefined), 20_000);
      process.kill(-(child.pid as number), "SIGINT");
      const [code] = (await w.closed) as [number | null];
      assert.equal(code, 130);
      assert.deepEqual(readFileSync(signalLog, "utf8").trim().split("\n"), ["SIGINT"]);
      assert.equal((await s.client.thread(t.id)).task?.state, "ready");
    } finally {
      child.kill("SIGKILL");
    }
  });
});

test("a second SIGINT kills the agent group at once and exits 130", async () => {
  await withServer(async (s) => {
    const t = await s.client.createTask({ room: "build", brief: "slow" });
    const pidFile = tempFile("pid");
    // The agent takes 30 s to exit after the first SIGINT; the second one must not wait for it.
    const env = { ...s.env, AGENT_PID_FILE: pidFile, AGENT_EXIT_DELAY_MS: "30000" };
    const child = spawnCli(["run", t.id, "--", "node", fixture("agent-slow.mjs")], env);
    try {
      const w = watch(s, child);
      const pid = await readPid(pidFile);
      child.kill("SIGINT");
      await waitFor(() => (s.logs.some((l) => /SIGINT, stopping/.test(l)) ? true : undefined));
      const secondAt = Date.now();
      child.kill("SIGINT");
      const [code] = (await w.closed) as [number | null];
      assert.equal(code, 130);
      assert.ok(Date.now() - secondAt < 5000, `run took ${Date.now() - secondAt} ms after the second SIGINT`);
      assert.equal(alive(pid), false, `agent ${pid} outlived run`);
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
      const w = watch(s, child);
      await waitFor(() => (s.logs.some((l) => l.includes("looking for a ready task in empty")) ? true : undefined), 20_000);
      const sentAt = Date.now();
      child.kill("SIGINT");
      const [code] = (await w.closed) as [number | null];
      assert.equal(code, 130);
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
