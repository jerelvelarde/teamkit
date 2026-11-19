import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createClient } from "@copilotkit/teamkit-client";
import { agentToken, startTestServer } from "../../../apps/server/test/helpers/server.js";
import { isolatedEnv, runCli } from "./helpers/cli.js";

async function setup() {
  const srv = await startTestServer();
  const token = await agentToken(srv.db, "bot");
  const client = createClient({ url: srv.url, token });
  const env = isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: token });
  return { srv, client, env };
}

test("claim --ready then complete from another process", async () => {
  const { srv, client, env } = await setup();
  try {
    const t = await client.createTask({ room: "build", brief: "do it\nmore" });
    const r = await runCli(["tasks", "claim", "--ready", "build", "--json"], env);
    assert.equal(r.code, 0, r.stderr);
    const claim = JSON.parse(r.stdout) as { task: { id: string }; claimId: string };
    assert.equal(claim.task.id, t.id);

    const done = await runCli(["tasks", "complete", t.id, "done"], env);
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.stdout.trim(), `${t.id}\tcompleted`);
    assert.equal((await client.tasks({ room: "build", state: "completed" })).length, 1);
  } finally {
    await srv.stop();
  }
});

test("claim --ready on an empty room exits 3 after the wait", async () => {
  const { srv, env } = await setup();
  try {
    const start = Date.now();
    const r = await runCli(["tasks", "claim", "--ready", "empty", "--wait", "1s"], env);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /nothing ready in empty/);
    assert.ok(Date.now() - start < 3000);
  } finally {
    await srv.stop();
  }
});

test("claim with no id and no --ready is a usage error", async () => {
  const { srv, env } = await setup();
  try {
    assert.equal((await runCli(["tasks", "claim"], env)).code, 2);
  } finally {
    await srv.stop();
  }
});

test("block, answer --choice, and the unblock alias", async () => {
  const { srv, client, env } = await setup();
  try {
    const t = await client.createTask({ room: "build", brief: "pick a db" });
    assert.equal((await runCli(["tasks", "claim", t.id], env)).code, 0);
    const b = await runCli(["tasks", "block", t.id, "which db?", "--options", "pg,sqlite"], env);
    assert.equal(b.code, 0, b.stderr);
    assert.equal(b.stdout.trim(), `${t.id}\tblocked`);

    const a = await runCli(["tasks", "answer", t.id, "--choice", "pg"], env);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.stdout.trim(), `${t.id}\tready`);

    assert.equal((await runCli(["tasks", "claim", t.id], env)).code, 0);
    assert.equal((await runCli(["tasks", "block", t.id, "again?"], env)).code, 0);
    const u = await runCli(["tasks", "unblock", t.id, "yes"], env);
    assert.equal(u.code, 0, u.stderr);
    assert.equal(u.stdout.trim(), `${t.id}\tready`);

    const none = await runCli(["tasks", "answer", t.id], env);
    assert.equal(none.code, 2);
  } finally {
    await srv.stop();
  }
});

test("a token cannot answer an awaiting_approval block", async () => {
  const { srv, client, env } = await setup();
  try {
    const t = await client.createTask({ room: "build", brief: "deploy" });
    assert.equal((await runCli(["tasks", "claim", t.id], env)).code, 0);
    const b = await runCli(["tasks", "block", t.id, "ship it?", "--kind", "awaiting_approval"], env);
    assert.equal(b.code, 0, b.stderr);
    const a = await runCli(["tasks", "answer", t.id, "yes"], env);
    assert.equal(a.code, 1);
    assert.match(a.stderr, /approval_requires_person/);
  } finally {
    await srv.stop();
  }
});

test("complete with no known claim exits 2", async () => {
  const { srv, client, env } = await setup();
  try {
    const t = await client.createTask({ room: "build", brief: "x" });
    assert.equal((await runCli(["tasks", "complete", t.id], env)).code, 2);
  } finally {
    await srv.stop();
  }
});

test("renew prints leaseExpiresAt; release returns the task to ready", async () => {
  const { srv, client, env } = await setup();
  try {
    const t = await client.createTask({ room: "build", brief: "x" });
    assert.equal((await runCli(["tasks", "claim", t.id], env)).code, 0);
    const r = await runCli(["tasks", "renew", t.id, "--json"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).leaseExpiresAt);
    const rel = await runCli(["tasks", "release", t.id], env);
    assert.equal(rel.code, 0, rel.stderr);
    assert.equal(rel.stdout.trim(), `${t.id}\tready`);
  } finally {
    await srv.stop();
  }
});

test("claim --ready --label claims the matching task, never the older reviewer one", async () => {
  const { srv, client, env } = await setup();
  try {
    const reviewer = await client.createTask({ room: "swarm", brief: "review", labels: { role: "reviewer" } });
    const worker = await client.createTask({ room: "swarm", brief: "work", labels: { role: "worker" } });
    const r = await runCli(["tasks", "claim", "--ready", "swarm", "--label", "role=worker", "--json"], env);
    assert.equal(r.code, 0, r.stderr);
    const claim = JSON.parse(r.stdout) as { task: { id: string } };
    assert.equal(claim.task.id, worker.id);
    assert.notEqual(claim.task.id, reviewer.id);
  } finally {
    await srv.stop();
  }
});

test("an unwritable state dir only warns: claim prints its JSON and complete succeeds", async () => {
  const { srv, client, env } = await setup();
  try {
    const t = await client.createTask({ room: "build", brief: "sandboxed" });
    const blocked = join(env.XDG_STATE_HOME as string, "file");
    writeFileSync(blocked, "x");
    const sandbox = { ...env, XDG_STATE_HOME: join(blocked, "state") };
    const r = await runCli(["tasks", "claim", t.id, "--json"], sandbox);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    const claim = JSON.parse(r.stdout) as { claimId: string };
    assert.match(r.stderr, /warning/);

    const done = await runCli(["tasks", "complete", t.id, "done"], {
      ...sandbox,
      TEAMKIT_TASK: t.id,
      TEAMKIT_CLAIM: claim.claimId,
    });
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.stdout.trim(), `${t.id}\tcompleted`);
  } finally {
    await srv.stop();
  }
});
