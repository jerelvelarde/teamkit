import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@copilotkit/teamkit-client";
import { agentToken, startTestServer } from "../../../apps/server/test/helpers/server.js";
import { runTask } from "../src/run.js";
import { isolatedEnv, runCli } from "./helpers/cli.js";

const agentEnvFixture = fileURLToPath(new URL("./fixtures/agent-env.mjs", import.meta.url));
const WARNING = "admin credentials in this shell are not passed to the agent";

const outFile = (): string => join(mkdtempSync(join(tmpdir(), "teamkit-run-env-")), "env.json");
const readOut = (file: string): Record<string, string | null> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, string | null>;

async function withServer(
  fn: (s: { url: string; token: string; client: ReturnType<typeof createClient> }) => Promise<void>,
): Promise<void> {
  const srv = await startTestServer();
  try {
    const token = await agentToken(srv.db, "bot");
    await fn({ url: srv.url, token, client: createClient({ url: srv.url, token }) });
  } finally {
    await srv.stop();
  }
}

test("runTask strips admin credentials from the agent's environment and warns once", async () => {
  await withServer(async (s) => {
    const task = await s.client.createTask({ room: "build", brief: "env" });
    const out = outFile();
    const logs: string[] = [];
    const code = await runTask({
      client: s.client,
      url: s.url,
      token: s.token,
      target: { taskId: task.id },
      command: [process.execPath, agentEnvFixture],
      env: { ...isolatedEnv(), TEAMKIT_ADMIN_TOKEN: "tk_admin_secret", TEAMKIT_ADMIN_EXTRA: "x", AGENT_ENV_OUT: out },
      log: (line) => logs.push(line),
      handleSignals: false,
    });
    assert.equal(code, 0);
    assert.deepEqual(readOut(out), { admin: null, extra: null, token: s.token, task: task.id });
    assert.equal(logs.filter((l) => l.includes(WARNING)).length, 1, logs.join("\n"));
    assert.ok(!logs.some((l) => l.includes("tk_admin_secret")));
  });
});

test("the bin strips TEAMKIT_ADMIN_TOKEN, warns on stderr and never prints the value", async () => {
  await withServer(async (s) => {
    await s.client.createTask({ room: "build", brief: "env" });
    const out = outFile();
    const env = isolatedEnv({
      TEAMKIT_URL: s.url,
      TEAMKIT_TOKEN: s.token,
      TEAMKIT_ADMIN_TOKEN: "tk_admin_secret",
      AGENT_ENV_OUT: out,
    });
    const r = await runCli(["run", "--ready", "build", "--wait", "2s", "--", process.execPath, agentEnvFixture], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readOut(out).admin, null);
    assert.ok(r.stderr.includes(WARNING), r.stderr);
    assert.ok(!r.stderr.includes("tk_admin_secret"));
    assert.ok(!r.stdout.includes("tk_admin_secret"));
  });
});

test("no warning when the environment has no admin credentials", async () => {
  await withServer(async (s) => {
    const task = await s.client.createTask({ room: "build", brief: "env" });
    const out = outFile();
    const logs: string[] = [];
    const code = await runTask({
      client: s.client,
      url: s.url,
      token: s.token,
      target: { taskId: task.id },
      command: [process.execPath, agentEnvFixture],
      env: { ...isolatedEnv(), AGENT_ENV_OUT: out },
      log: (line) => logs.push(line),
      handleSignals: false,
    });
    assert.equal(code, 0);
    assert.equal(readOut(out).admin, null);
    assert.equal(logs.filter((l) => l.includes(WARNING)).length, 0, logs.join("\n"));
  });
});
