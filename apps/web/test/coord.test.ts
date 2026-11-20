import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Alert, ChangeEntry, Presence, TaskBlock, Whoami } from "@copilotkit/teamkit-protocol";
import {
  ackText,
  agentsOn,
  approverList,
  bannerAlerts,
  heldText,
  liveSessions,
  mayAnswer,
  namesText,
  parseTab,
  presenceLine,
  reservationLeft,
  roomQuery,
  shortDuration,
  sortChanges,
  whenText,
} from "../lib/coord.js";

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
  it("heldText reads like the index and disappears when the hold lapses", () => {
    const now = Date.parse("2026-11-19T10:06:00.000Z");
    const t = { state: "ready" as const, reservedFor: benAgent, reservedUntil: "2026-11-19T10:30:00.000Z" };
    assert.equal(heldText(t, now), "Held for ben-agent · 24m");
    assert.equal(heldText(t, Date.parse("2026-11-19T10:30:00.000Z")), "");
    assert.equal(heldText(t, Date.parse("2026-11-19T10:45:00.000Z")), "");
    assert.equal(heldText({ ...t, state: "blocked" }, now), "");
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

describe("room views", () => {
  it("tabs live in the query string next to the room", () => {
    assert.deepEqual([null, "decisions", "changes", "Decisions", "board", "nope"].map(parseTab),
      ["board", "decisions", "changes", "board", "board", "board"]);
    assert.equal(roomQuery(null), "");
    assert.equal(roomQuery("*", "decisions"), "");
    assert.equal(roomQuery("billing-prod"), "?room=billing-prod");
    assert.equal(roomQuery("billing-prod", "board"), "?room=billing-prod");
    assert.equal(roomQuery("billing-migration", "decisions"), "?room=billing-migration&view=decisions");
  });
  it("the log is a tab in one room and across all rooms", () => {
    assert.equal(parseTab("log"), "log");
    assert.equal(roomQuery("launch", "log"), "?room=launch&view=log");
    assert.equal(roomQuery("*", "log"), "?view=log");
    assert.equal(roomQuery(null, "log"), "?view=log");
    assert.equal(roomQuery("*", "board"), "");
  });
  it("ackText", () => {
    assert.deepEqual([0, 1, 3].map(ackText), ["No acks yet", "1 ack", "3 acks"]);
  });
  it("whenText shows the time today and the date before today", () => {
    const now = new Date(2026, 10, 19, 15, 0).getTime();
    const today = new Date(2026, 10, 19, 10, 42);
    const before = new Date(2026, 10, 18, 10, 42);
    assert.equal(whenText(today.toISOString(), now), new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(today));
    assert.equal(whenText(before.toISOString(), now), new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(before));
    assert.equal(whenText("not a date", now), "");
  });
});

const AT = "2026-11-19T10:00:00.000Z";
const change: ChangeEntry = {
  id: "chg_1", room: "billing-migration", threadId: "th_copy", what: "Copied invoices 1 to 500 to the new database",
  where: "billing-db-new", at: AT, person: { id: "act_ben", name: "ben", kind: "person" }, agent: benAgent,
  undo: "Delete the copied rows from billing-db-new", undoWhen: "If the row counts differ", status: "active", createdAt: AT, updatedAt: AT,
};

describe("change log", () => {
  it("sortChanges puts active changes first, newest first within each group", () => {
    const c = (id: string, status: ChangeEntry["status"], at: string) => ({ ...change, id, status, at });
    const list = [c("a", "done", "2026-11-19T12:00:00Z"), c("b", "active", "2026-11-19T09:00:00Z"),
      c("c", "restored", "2026-11-19T13:00:00Z"), c("d", "active", "2026-11-19T11:00:00Z")];
    assert.deepEqual(sortChanges(list).map((x) => x.id), ["d", "b", "c", "a"]);
    assert.deepEqual(list.map((x) => x.id), ["a", "b", "c", "d"]);
  });
});

const alert: Alert = { // plan 02's shape for ben-agent's suspected alert
  id: "alr_1", room: "billing-prod", threadId: "th_alert", text: "Invoice totals differ between the old and new databases",
  level: "suspected", raisedBy: benAgent, confirmedBy: null, source: null, resolvedBy: null, resolvedSource: null, resolvedAt: null,
  createdAt: "2026-11-19T10:00:00.000Z",
};
describe("alert banner", () => {
  const sam = { id: "act_sam", name: "sam", kind: "person" as const };
  const a = (id: string, level: Alert["level"], createdAt: string, resolved = false): Alert =>
    ({ ...alert, id, level, createdAt, ...(resolved ? { resolvedBy: sam, resolvedSource: sam, resolvedAt: "2026-11-20T08:50:00.000Z" } : {}) });
  const list = [
    a("s1", "suspected", "2026-11-20T08:00:00.000Z"), a("c1", "confirmed", "2026-11-20T07:00:00.000Z"),
    a("s2", "suspected", "2026-11-20T08:30:00.000Z"), a("s3", "suspected", "2026-11-20T06:00:00.000Z"),
    a("old", "confirmed", "2026-11-12T08:00:00.000Z"), a("done", "confirmed", "2026-11-20T08:45:00.000Z", true),
  ];
  it("shows unresolved alerts at any age, confirmed first, newest first, at most three", () => {
    const { shown, more } = bannerAlerts(list);
    assert.deepEqual(shown.map((x) => x.id), ["c1", "old", "s2"]);
    assert.deepEqual(more.map((x) => x.id), ["s1", "s3"]);
  });
  it("an empty or all-resolved list shows nothing", () => {
    assert.deepEqual(bannerAlerts([]), { shown: [], more: [] });
    assert.deepEqual(bannerAlerts([a("done", "confirmed", "2026-11-20T08:45:00.000Z", true)]), { shown: [], more: [] });
  });
});

describe("presence", () => {
  it("only agents seen in the last 90 seconds are on", () => {
    const now = Date.parse("2026-11-19T10:00:00.000Z");
    const s = (tokenId: string, agoMs: number) => ({ tokenId, watching: ["billing-migration"], status: null, lastSeenAt: new Date(now - agoMs).toISOString() });
    const ana = { id: "act_ana", name: "ana", kind: "person" as const };
    const list: Presence[] = [
      { actor: benAgent, owner: null, sessions: [s("tok_b", 91_000)] },
      { actor: anaAgent, owner: ana, sessions: [s("tok_a1", 5_000), s("tok_a2", 60_000), s("tok_a3", 120_000)] },
      { actor: ana, owner: null, sessions: [s("tok_p", 1_000)] },
    ];
    assert.deepEqual(agentsOn(list, now).map((p) => p.actor.name), ["ana-agent"]);
    assert.equal(liveSessions(list[1]!, now), 2);
    assert.equal(presenceLine(list[1]!, now), "ana-agent · 2 sessions");
    assert.equal(presenceLine({ ...list[1]!, sessions: [s("tok_a1", 5_000)] }, now), "ana-agent");
  });
});
