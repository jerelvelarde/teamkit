import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventKind } from "@copilotkit/teamkit-protocol";
import type { SlackAnnounce } from "../src/slack/mirror.js";
import { placeTaskEvent, TASK_EVENT_KINDS } from "../src/slack/parent-rule.js";

test("only an ask, or announce all, gives a task its parent; afterwards events go in its thread", () => {
  const p = (kind: EventKind, announce: SlackAnnounce, hasParent: boolean) => placeTaskEvent({ kind, announce, hasParent });
  assert.equal(p("task.blocked", "blocked", false), "top");
  assert.equal(p("task.blocked", "blocked", true), "thread-broadcast");
  assert.equal(p("task.created", "blocked", false), "skip");
  assert.equal(p("task.created", "all", false), "top");
  assert.equal(p("task.created", "all", true), "skip");
  for (const kind of TASK_EVENT_KINDS.filter((k) => k !== "task.blocked" && k !== "task.created")) {
    assert.equal(p(kind, "blocked", false), "skip");
    assert.equal(p(kind, "blocked", true), "thread");
    assert.equal(p(kind, "all", false), "parent-then-thread");
    assert.equal(p(kind, "all", true), "thread");
  }
  for (const kind of TASK_EVENT_KINDS) for (const hasParent of [true, false]) assert.equal(p(kind, "none", hasParent), "skip");
});
