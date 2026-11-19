import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@copilotkit/teamkit-client";
import { agentToken, startTestServer } from "../../../apps/server/test/helpers/server.js";
import { isolatedEnv, runCli } from "./helpers/cli.js";

test("post, reply and label round-trip", async () => {
  const srv = await startTestServer();
  try {
    const token = await agentToken(srv.db, "bot");
    const env = isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: token });

    const posted = await runCli(["post", "build", "hello", "--json"], env);
    assert.equal(posted.code, 0, posted.stderr);
    const { threadId } = JSON.parse(posted.stdout) as { threadId: string };
    assert.match(threadId, /^th_/);

    const replied = await runCli(["reply", threadId, "second"], env);
    assert.equal(replied.code, 0, replied.stderr);
    assert.equal(replied.stdout.trim(), "ok");

    const labelled = await runCli(["label", threadId, "kind=chat", "--json"], env);
    assert.equal(labelled.code, 0, labelled.stderr);
    assert.deepEqual(JSON.parse(labelled.stdout), { ok: true });

    const view = await createClient({ url: srv.url, token }).thread(threadId);
    assert.equal(view.messages.length, 2);
    assert.equal(view.thread.labels.kind, "chat");
  } finally {
    await srv.stop();
  }
});

test("label without = exits 2", async () => {
  const srv = await startTestServer();
  try {
    const token = await agentToken(srv.db, "bot");
    const env = isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: token });
    const r = await runCli(["label", "th_x", "novalue"], env);
    assert.equal(r.code, 2);
  } finally {
    await srv.stop();
  }
});

test("a read-only agent posting exits 1 with forbidden", async () => {
  const srv = await startTestServer();
  try {
    const token = await agentToken(srv.db, "ro", [{ room: "*", perms: ["read"] }]);
    const env = isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: token });
    const r = await runCli(["post", "build", "nope"], env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /forbidden/);
  } finally {
    await srv.stop();
  }
});
