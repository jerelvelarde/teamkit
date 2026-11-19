import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { Db } from "../src/db/pool.js";
import { slackBridgeConfigFromEnv, slackBridgeEnabled } from "../src/slack/bridge-config.js";
import { startSlackBridge } from "../src/slack/bridge.js";
import { loadedSpecifiers } from "./helpers/module-probe.js";

const src = (rel: string) => fileURLToPath(new URL(`../src/${rel}`, import.meta.url));

/** A Db stand-in that fails the test on any use. */
const untouchableDb = new Proxy(() => {}, {
  get() {
    throw new Error("the db was used");
  },
  apply() {
    throw new Error("the db was used");
  },
}) as unknown as Db;

const heavy = (specs: string[]) =>
  specs.filter(
    (s) =>
      s.startsWith("@copilotkit/channels") ||
      s.startsWith("@copilotkit/runtime") ||
      s.endsWith("handlers.js") ||
      s.endsWith("answer.js") ||
      s.endsWith("cards.js"),
  );

test("startSlackBridge returns null quickly without the env, and never touches the db", async () => {
  const cases = [
    {},
    { CPK_INTELLIGENCE_API_KEY: "cpk-test" },
    { TEAMKIT_SLACK_CHANNEL_NAME: "teamkit" },
    { CPK_INTELLIGENCE_API_KEY: "", TEAMKIT_SLACK_CHANNEL_NAME: "" },
  ];
  for (const env of cases) {
    const started = performance.now();
    const bridge = await startSlackBridge({
      db: untouchableDb,
      config: slackBridgeConfigFromEnv(env, "http://127.0.0.1:3000"),
      log: () => assert.fail("logged while off"),
    });
    assert.equal(bridge, null, JSON.stringify(env));
    assert.ok(performance.now() - started < 200, "resolved in under 200 ms");
  }
});

test("slackBridgeConfigFromEnv maps every variable, and slackBridgeEnabled needs key and channel", () => {
  const full = slackBridgeConfigFromEnv(
    {
      CPK_INTELLIGENCE_API_KEY: "cpk-test",
      CPK_INTELLIGENCE_API_URL: "http://127.0.0.1:9/api",
      CPK_INTELLIGENCE_WS_URL: "ws://127.0.0.1:9",
      TEAMKIT_SLACK_CHANNEL_NAME: "teamkit",
      TEAMKIT_SLACK_DEFAULT_ROOM: "inbox",
    },
    "https://board.example.com",
  );
  assert.deepEqual(full, {
    intelligenceApiKey: "cpk-test",
    intelligenceApiUrl: "http://127.0.0.1:9/api",
    intelligenceWsUrl: "ws://127.0.0.1:9",
    channelName: "teamkit",
    publicUrl: "https://board.example.com",
    defaultRoom: "inbox",
  });
  assert.equal(slackBridgeEnabled(full), true);

  const empty = slackBridgeConfigFromEnv(
    {
      CPK_INTELLIGENCE_API_KEY: "",
      CPK_INTELLIGENCE_API_URL: "",
      CPK_INTELLIGENCE_WS_URL: "",
      TEAMKIT_SLACK_CHANNEL_NAME: "",
      TEAMKIT_SLACK_DEFAULT_ROOM: "",
    },
    "http://127.0.0.1:3000",
  );
  assert.deepEqual(empty, {
    intelligenceApiKey: undefined,
    intelligenceApiUrl: undefined,
    intelligenceWsUrl: undefined,
    channelName: undefined,
    publicUrl: "http://127.0.0.1:3000",
    defaultRoom: null,
  });
  assert.equal(slackBridgeEnabled(empty), false);
  assert.equal(slackBridgeConfigFromEnv({}, "http://127.0.0.1:3000").defaultRoom, null);

  const base = { publicUrl: "http://127.0.0.1:3000", defaultRoom: null };
  assert.equal(slackBridgeEnabled({ ...base, intelligenceApiKey: "cpk-test" }), false);
  assert.equal(slackBridgeEnabled({ ...base, channelName: "teamkit" }), false);
  assert.equal(slackBridgeEnabled({ ...base, intelligenceApiKey: "cpk-test", channelName: "teamkit" }), true);
});

test("importing bridge-config.ts or bridge.ts loads no Channels, runtime or Slack handler module", async () => {
  for (const entry of ["slack/bridge-config.ts", "slack/bridge.ts"]) {
    const specs = await loadedSpecifiers(src(entry));
    assert.ok(specs.length > 0, `${entry}: the probe saw no imports`);
    assert.deepEqual(heavy(specs), [], entry);
  }
});

test("the module probe sees Channels and source-written specifiers when they do load", async () => {
  const cards = await loadedSpecifiers(src("slack/cards.tsx"));
  assert.ok(cards.some((s) => s.startsWith("@copilotkit/channels")));
  // Relative specifiers arrive as written ("./cards.js"), not as tsx rewrites them ("./cards.tsx"),
  // so the ".js" checks above can fail.
  const handlers = await loadedSpecifiers(src("slack/handlers.ts"));
  assert.ok(handlers.includes("./cards.js"), "handlers.ts imports ./cards.js");
  assert.ok(handlers.some((s) => s.startsWith("@copilotkit/channels")));
});
