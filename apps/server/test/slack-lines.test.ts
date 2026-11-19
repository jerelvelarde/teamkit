import { test } from "node:test";
import assert from "node:assert/strict";
import type { Alert, ChangeEntry } from "@copilotkit/teamkit-protocol";
import { toSlackMessage } from "../src/slack/blocks.js";
import { DecisionCard } from "../src/slack/cards.js";
import {
  alertConfirmedLine,
  answeredLine,
  changeLoggedLine,
  changeUpdatedLine,
  claimedLine,
  handoffLine,
  progressLine,
  refusalLine,
} from "../src/slack/lines.js";

const ben = { id: "ac_b", name: "ben", kind: "person" } as const;
const benAgent = { id: "ac_ba", name: "ben-agent", kind: "agent" } as const;
const sam = { id: "ac_s", name: "sam", kind: "person" } as const;
const change: ChangeEntry = {
  id: "chg_1", room: "billing-migration", threadId: "tsk_1", what: "Switched invoice writes to the new database",
  where: "billing-prod", at: "2026-11-19T17:55:00.000Z", person: ben, agent: benAgent,
  undo: "Point invoice writes back to the old database", undoWhen: "after the 18:00 UTC check",
  status: "active", createdAt: "2026-11-19T17:55:00.000Z", updatedAt: "2026-11-19T17:55:00.000Z",
};
const alert: Alert = { // as plan 02 stores it after sam confirms: sam is also the source
  id: "alr_1", room: "billing-prod", threadId: "thr_a", text: "Invoice totals differ between the old and new database.",
  level: "confirmed", raisedBy: benAgent, confirmedBy: sam, source: sam, resolvedBy: null, resolvedSource: null, resolvedAt: null,
  createdAt: "2026-11-19T18:02:00.000Z",
};

test("thread lines use the decided copy", () => {
  assert.equal(claimedLine("ben-agent"), "ben-agent claimed this task.");
  assert.equal(answeredLine("sam", "approve"), "sam answered: approve");
  assert.equal(handoffLine("ana-agent", "ben-agent", 30), "ana-agent handed this task to ben-agent. It is held for ben-agent for 30 min.");
  assert.equal(handoffLine("ana-agent", "ben-agent", null), "ana-agent handed this task to ben-agent.");
  assert.equal(progressLine("ben-agent", "Copied 40% of invoice rows."), "*ben-agent:* Copied 40% of invoice rows.");
  assert.equal(changeLoggedLine(change), "Change logged by ben-agent for ben: Switched invoice writes to the new database · where: billing-prod · undo: Point invoice writes back to the old database · undo when: after the 18:00 UTC check");
  assert.equal(changeLoggedLine({ ...change, agent: null, undoWhen: null }), "Change logged by ben: Switched invoice writes to the new database · where: billing-prod · undo: Point invoice writes back to the old database");
  assert.equal(changeUpdatedLine({ ...change, status: "done" }, "ben-agent"), "ben-agent marked a change done: Switched invoice writes to the new database");
  assert.equal(alertConfirmedLine(alert), "<!here> Confirmed by sam: Invoice totals differ between the old and new database.");
  assert.equal(alertConfirmedLine({ ...alert, confirmedBy: benAgent, source: ben }), "<!here> Confirmed by ben-agent for ben: Invoice totals differ between the old and new database.");
  assert.equal(refusalLine(["sam"]), "This waits on sam. Only sam or an admin can answer it.");
  assert.equal(refusalLine(["ana", "sam"]), "This waits on ana or sam. Only they or an admin can answer it.");
  assert.equal(refusalLine(null), "Only a listed approver or an admin can answer this.");
});

test("lines and cards escape every value", () => {
  const evil = "<!channel> done [x](http://evil.test) <@U0SAM>";
  for (const s of [progressLine("ben-agent", evil), answeredLine("sam", evil), changeLoggedLine({ ...change, what: evil }), alertConfirmedLine({ ...alert, text: evil })]) {
    assert.ok(!s.includes("<!channel>") && !s.includes("<@U0SAM>") && !s.includes("](http"), s);
  }
  assert.equal(alertConfirmedLine({ ...alert, text: "<!here> twice" }).split("<!here>").length, 2);
  const d = toSlackMessage(DecisionCard({ decision: { id: "dec_1", room: "billing-migration", threadId: "thr_d", text: evil, decidedBy: { id: "ac_a", name: "ana", kind: "person" }, postedBy: { id: "ac_a", name: "ana", kind: "person" }, createdAt: "2026-11-19T17:00:00.000Z", acks: [] } }));
  assert.ok(!JSON.stringify(d).includes("<!channel>"));
});
