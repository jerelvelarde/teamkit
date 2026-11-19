import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskBlock, Whoami } from "@copilotkit/teamkit-protocol";
import { approverList, mayAnswer, namesText, reservationLeft, shortDuration } from "../lib/coord.js";

const anaAgent = { id: "act_ana_agent", name: "ana-agent", kind: "agent" as const };
const benAgent = { id: "act_ben_agent", name: "ben-agent", kind: "agent" as const };
const who = (name: string, role: "admin" | "member"): Whoami => ({ actor: { id: `act_${name}`, name, kind: "person" }, scope: null, role });
const approval = (over: Partial<TaskBlock> = {}): TaskBlock => ({
  interruptId: "in_1", kind: "awaiting_approval", question: "Switch writes now?", options: ["approve", "reject"],
  blockedBy: anaAgent, approvers: null, ...over,
});
const MIN = 60_000;

describe("durations and reservations", () => {
  it("shortDuration", () => {
    assert.deepEqual([24 * MIN, 30_000, 60 * MIN, 65 * MIN, 190 * MIN, 0, -5, Number.NaN].map(shortDuration),
      ["24m", "1m", "1h", "1h 5m", "3h", "", "", ""]);
  });
  it("reservationLeft only for a ready task with a live reservation", () => {
    const now = Date.parse("2026-11-19T10:06:00.000Z");
    const t = { state: "ready" as const, reservedFor: benAgent, reservedUntil: "2026-11-19T10:30:00.000Z" };
    assert.equal(reservationLeft(t, now), "24m");
    assert.equal(reservationLeft({ ...t, state: "claimed" }, now), null);
    assert.equal(reservationLeft({ ...t, reservedFor: null, reservedUntil: null }, now), null);
    assert.equal(reservationLeft({ ...t, reservedUntil: "not a date" }, now), null);
    assert.equal(reservationLeft(t, Date.parse("2026-11-19T10:30:00.000Z")), null);
  });
});

describe("approvers", () => {
  it("namesText", () => {
    assert.equal(namesText([], "and"), "");
    assert.equal(namesText(["sam"], "or"), "sam");
    assert.equal(namesText(["sam", "ana"], "or"), "sam or ana");
    assert.equal(namesText(["ana-agent", "ben-agent", "sam-agent"], "and"), "ana-agent, ben-agent and sam-agent");
  });
  it("approverList prefers named approvers, then the room list, then any member", () => {
    assert.deepEqual(approverList(approval({ approvers: ["sam"] }), ["sam", "ana"]), ["sam"]);
    assert.deepEqual(approverList(approval({ approvers: [] }), ["sam"]), ["sam"]);
    assert.equal(approverList(approval(), []), null);
    assert.equal(approverList(approval(), null), null);
  });
  it("mayAnswer: named people on either kind, else the room list for approvals, else anyone", () => {
    assert.equal(mayAnswer(approval({ approvers: ["sam"] }), null, who("sam", "member")), true);
    assert.equal(mayAnswer(approval({ approvers: ["sam"] }), null, who("ana", "member")), false);
    assert.equal(mayAnswer(approval({ approvers: ["sam"] }), null, who("ben", "admin")), true);
    assert.equal(mayAnswer(approval(), ["sam"], who("ana", "member")), false);
    assert.equal(mayAnswer(approval(), null, who("ana", "member")), true);
    assert.equal(mayAnswer(approval(), undefined, who("sam", "member")), false);
    const question = (approvers: string[] | null) => approval({ kind: "needs_input", question: "Which batch size?", approvers });
    assert.equal(mayAnswer(question(["sam"]), undefined, who("ana", "member")), false);
    assert.equal(mayAnswer(question(["sam"]), undefined, who("sam", "member")), true);
    assert.equal(mayAnswer(question(["sam"]), undefined, who("ana", "admin")), true);
    assert.equal(mayAnswer(question(null), ["sam"], who("ana", "member")), true);
  });
});
