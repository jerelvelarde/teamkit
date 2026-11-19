import { test } from "node:test";
import assert from "node:assert/strict";
import type { Notifier } from "../src/notifier.js";
import { startPassLoop } from "../src/slack/pass-loop.js";

test("startPassLoop runs a pass per notification, backs off on a retry and logs with its label", async () => {
  let fire = () => {};
  const notifier: Notifier = { onEvent: (cb) => ((fire = () => cb(null)), () => {}), close: async () => {} };
  const results = [{ retry: { reason: "http 429", afterMs: 50 } }, { retry: null }];
  let passes = 0;
  const lines: string[] = [];
  const loop = startPassLoop({ label: "slack-status", notifier, pollMs: 60_000, log: (l) => lines.push(l), pass: async () => results[Math.min(passes++, 1)]! });
  for (let i = 0; i < 100 && passes < 2; i++) await new Promise((r) => setTimeout(r, 10));
  fire();
  for (let i = 0; i < 100 && passes < 3; i++) await new Promise((r) => setTimeout(r, 10));
  await loop.stop();
  assert.equal(passes, 3);
  assert.equal(lines[0], "slack-status: paused, http 429; retrying in 1 s");
  assert.ok(lines.some((l) => l.startsWith("slack-status: resumed after 1 failed pass")));
});
