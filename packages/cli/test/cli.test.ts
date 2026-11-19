import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Task } from "@copilotkit/teamkit-protocol";
import { createClient } from "@copilotkit/teamkit-client";
import { agentToken, startTestServer } from "../../../apps/server/test/helpers/server.js";
import { isolatedEnv, runCli } from "./helpers/cli.js";

async function withServer(
  fn: (ctx: { srv: Awaited<ReturnType<typeof startTestServer>>; env: NodeJS.ProcessEnv; token: string }) => Promise<void>,
): Promise<void> {
  const srv = await startTestServer();
  try {
    const token = await agentToken(srv.db, "bot");
    const env = isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: token });
    await fn({ srv, env, token });
  } finally {
    await srv.stop();
  }
}

function planFile(plan: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), "teamkit-plan-")), "plan.json");
  writeFileSync(file, JSON.stringify(plan));
  return file;
}

test("tasks create and tasks list", async () => {
  await withServer(async ({ env }) => {
    const created = await runCli(["tasks", "create", "build", "x", "--json"], env);
    assert.equal(created.code, 0, created.stderr);
    const task = JSON.parse(created.stdout) as Task;
    assert.equal(task.state, "ready");

    const plain = await runCli(["tasks", "create", "build", "y", "--label", "a=b", "--label", "c=d"], env);
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout.trim(), /^th_\S+\tready$/);

    const listed = await runCli(["tasks", "build", "--json"], env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.ok((JSON.parse(listed.stdout) as Task[]).some((t) => t.id === task.id));

    const filtered = await runCli(["tasks", "build", "--label", "a=b", "--json"], env);
    assert.equal((JSON.parse(filtered.stdout) as Task[]).length, 1);

    const text = await runCli(["tasks", "build"], env);
    assert.ok(text.stdout.includes(task.id));

    const bad = await runCli(["tasks", "build", "--state", "nope"], env);
    assert.equal(bad.code, 2);
  });
});

test("tasks create --file builds a plan with needs by key", async () => {
  await withServer(async ({ env }) => {
    const file = planFile([
      { key: "limiter", text: "write the limiter" },
      { key: "review", text: "review the limiter", needs: ["limiter"], labels: { role: "reviewer" } },
    ]);
    const r = await runCli(["tasks", "create", "build", "--file", file, "--json"], env);
    assert.equal(r.code, 0, r.stderr);
    const map = JSON.parse(r.stdout) as Record<string, Task>;
    assert.equal(map.limiter?.state, "ready");
    assert.equal(map.review?.state, "waiting");

    const wrapped = planFile({ tasks: [{ key: "solo", text: "alone" }] });
    const text = await runCli(["tasks", "create", "build", "--file", wrapped], env);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout.trim(), /^solo\tth_\S+\tready$/);
  });
});

test("failed need shows in the task list", async () => {
  await withServer(async ({ env, srv, token }) => {
    const file = planFile([
      { key: "limiter", text: "write the limiter" },
      { key: "review", text: "review the limiter", needs: ["limiter"] },
    ]);
    const r = await runCli(["tasks", "create", "build", "--file", file, "--json"], env);
    assert.equal(r.code, 0, r.stderr);
    const map = JSON.parse(r.stdout) as Record<string, Task>;

    const client = createClient({ url: srv.url, token });
    const claim = await client.claim(map.limiter!.id);
    await client.fail(map.limiter!.id, claim.claimId, "boom");

    const listed = await runCli(["tasks", "build", "--state", "all"], env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.ok(listed.stdout.includes("(failed)"), listed.stdout);
  });
});

test("tasks create usage and server errors", async () => {
  await withServer(async ({ env }) => {
    const noBrief = await runCli(["tasks", "create", "build"], env);
    assert.equal(noBrief.code, 2);

    const unknown = await runCli(["tasks", "create", "build", "x", "--needs", "th_nope", "--json"], env);
    assert.equal(unknown.code, 1);
    const parsed = JSON.parse(unknown.stderr).error as { code: string; message: string };
    assert.equal(parsed.code, "invalid_input");
    assert.ok(!parsed.message.startsWith("error:") && !parsed.message.startsWith("invalid_input:"), parsed.message);

    const file = planFile([{ key: "a", text: "one" }]);
    for (const extra of [["brief"], ["--label", "a=b"], ["--needs", "th_x"], ["--target", "t"]]) {
      const args = extra[0] === "brief" ? ["tasks", "create", "build", "brief", "--file", file] : ["tasks", "create", "build", "--file", file, ...extra];
      assert.equal((await runCli(args, env)).code, 2, extra.join(" "));
    }

    const missing = await runCli(["tasks", "create", "build", "--file", "/nonexistent/plan.json"], env);
    assert.equal(missing.code, 2);

    const badJson = join(mkdtempSync(join(tmpdir(), "teamkit-plan-")), "bad.json");
    writeFileSync(badJson, "{nope");
    assert.equal((await runCli(["tasks", "create", "build", "--file", badJson], env)).code, 2);
    assert.equal((await runCli(["tasks", "create", "build", "--file", planFile([{ key: 1 }])], env)).code, 2);
  });
});
