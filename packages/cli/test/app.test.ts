import assert from "node:assert/strict";
import { test } from "node:test";
import { appFromPath, resolveApp } from "../src/app.js";
import { UsageError } from "../src/errors.js";

test("appFromPath reads the app from the folder the CLI is installed in", () => {
  assert.equal(appFromPath("/home/ana/.claude/plugins/cache/teamkit/teamkit/0.1.0/bin/teamkit.mjs"), "claude");
  assert.equal(appFromPath("/home/ana/.codex/plugins/teamkit/bin/teamkit.mjs"), "codex");
  assert.equal(appFromPath("C:\\Users\\ana\\.codex\\plugins\\teamkit\\bin\\teamkit.mjs"), "codex");
  // The folder nearest the script wins.
  assert.equal(appFromPath("/home/ana/.codex/x/.claude/plugins/teamkit/bin/teamkit.mjs"), "claude");
  for (const none of [undefined, "", "teamkit", "/usr/local/bin/teamkit", "/home/ana/claude/bin/teamkit.mjs", "/home/ana/.claude-tools/teamkit.mjs", "/home/ana/my.codex/teamkit.mjs"]) {
    assert.equal(appFromPath(none), undefined, String(none));
  }
});

test("resolveApp: --app, then TEAMKIT_APP, then the install path, else none", () => {
  const claudePath = "/home/ana/.claude/plugins/teamkit/bin/teamkit.mjs";
  assert.equal(resolveApp({ app: "codex" }, { TEAMKIT_APP: "claude" }, claudePath), "codex");
  assert.equal(resolveApp({}, { TEAMKIT_APP: "codex" }, claudePath), "codex");
  assert.equal(resolveApp({}, {}, claudePath), "claude");
  assert.equal(resolveApp({}, { TEAMKIT_APP: "" }, claudePath), "claude");
  assert.equal(resolveApp({}, {}, "/usr/local/bin/teamkit"), undefined);
  assert.equal(resolveApp({}, {}), undefined);
});

test("an unknown --app or TEAMKIT_APP is a usage error that lists the apps", () => {
  assert.throws(
    () => resolveApp({ app: "cursor" }, {}),
    (e: unknown) => e instanceof UsageError && e.code === 2 && e.message === "--app must be one of claude, codex (got cursor)",
  );
  assert.throws(
    () => resolveApp({}, { TEAMKIT_APP: "Claude" }),
    (e: unknown) => e instanceof UsageError && e.message === "TEAMKIT_APP must be one of claude, codex (got Claude)",
  );
  // A bad --app is refused even where the path would have named the app.
  assert.throws(() => resolveApp({ app: "agent" }, {}, "/home/ana/.claude/bin/teamkit.mjs"), UsageError);
});
