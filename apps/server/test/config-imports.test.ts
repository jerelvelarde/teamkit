import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadedSpecifiers } from "./helpers/module-probe.js";

test("config.ts does not load Channels or the runtime", async () => {
  const specifiers = await loadedSpecifiers(fileURLToPath(new URL("../src/config.ts", import.meta.url)));
  const heavy = specifiers.filter((s) => s.startsWith("@copilotkit/channels") || s.startsWith("@copilotkit/runtime"));
  assert.deepEqual(heavy, []);
});
