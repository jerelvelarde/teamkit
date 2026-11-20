import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BoardEvent } from "@copilotkit/teamkit-protocol";
import type { ActorView, ViewItem } from "../lib/fold.js";
import { LOG_KINDS, buildLog, dayLabel, keepRecent, sameAuthor, withSubject } from "../lib/log.js";

const lead = { id: "a1", name: "lead", kind: "agent" as const };
const maya = { id: "p1", name: "maya", kind: "person" as const };

function ev(cursor: string, threadId: string | null, createdAt: string, actor: BoardEvent["actor"] = lead, room = "launch"): BoardEvent {
  return { cursor, kind: "task.created", room, threadId, actor, agui: [], data: {}, createdAt };
}
const status = (cursor: string, label: string): ViewItem => ({ kind: "status", id: `s-${cursor}`, label, tone: "info", detail: null, cursor });
const msg = (cursor: string, text: string, actor: ActorView = { name: "lead", kind: "agent" }): ViewItem => ({
  kind: "message", id: `m-${cursor}`, role: "assistant", text, actor, streaming: false, cursor,
});

describe("room log", () => {
  it("leaves out run events and label changes, and keeps everything else", () => {
    assert.ok(!LOG_KINDS.includes("run.event"));
    assert.ok(!LOG_KINDS.includes("label.set"));
    for (const k of ["task.created", "task.blocked", "message.posted", "decision.posted", "alert.raised", "change.logged"] as const) {
      assert.ok(LOG_KINDS.includes(k), k);
    }
  });

  it("keeps only the most recent events", () => {
    assert.deepEqual(keepRecent([1, 2, 3, 4, 5], 3), [3, 4, 5]);
    assert.deepEqual(keepRecent([1, 2], 3), [1, 2]);
  });

  it("names days like a chat: Today, Yesterday, then the weekday and date", () => {
    const now = new Date(2026, 10, 19, 15, 0);
    assert.equal(dayLabel(new Date(2026, 10, 19, 9, 0), now), "Today");
    assert.equal(dayLabel(new Date(2026, 10, 18, 23, 59), now), "Yesterday");
    assert.equal(dayLabel(new Date(2026, 10, 17, 9, 0), now), "Tuesday, Nov 17");
  });

  it("gives a subjectless status line its actor", () => {
    assert.equal((withSubject(status("1", "Task created"), lead) as { label: string }).label, "lead created the task");
    assert.equal((withSubject(status("1", "Completed"), lead) as { label: string }).label, "lead completed the task");
    assert.equal((withSubject(status("1", "Claimed by writer"), lead) as { label: string }).label, "Claimed by writer");
    assert.equal((withSubject(status("1", "Completed"), null) as { label: string }).label, "Completed");
  });

  it("folds two messages from one author, not from two", () => {
    assert.ok(sameAuthor(msg("1", "a"), msg("2", "b")));
    assert.ok(!sameAuthor(msg("1", "a"), msg("2", "b", { name: "maya", kind: "person" as const })));
    assert.ok(!sameAuthor(status("1", "x"), msg("2", "b")));
  });

  it("groups a run of one task's events, starts a new group when the task changes, and divides days", () => {
    const now = new Date(2026, 10, 19, 15, 0);
    const events = new Map<string, BoardEvent>([
      ["1", ev("1", "t1", new Date(2026, 10, 18, 10, 0).toISOString())],
      ["2", { ...ev("2", "t1", new Date(2026, 10, 19, 9, 0).toISOString()), kind: "message.posted" }],
      ["3", ev("3", "t1", new Date(2026, 10, 19, 9, 1).toISOString(), maya)],
      ["4", ev("4", "t2", new Date(2026, 10, 19, 9, 2).toISOString())],
      ["5", ev("5", null, new Date(2026, 10, 19, 9, 3).toISOString(), maya)],
    ]);
    const rows = buildLog(
      [status("1", "Task created"), msg("2", "Plan: draft the notes."), status("3", "Answered by maya"), status("4", "Task created"), status("5", "Decision posted")],
      events,
      now,
    );
    assert.deepEqual(
      rows.map((r) => (r.kind === "day" ? `day:${r.label}` : `group:${r.threadId}:${r.items.map((i) => i.item.cursor).join(",")}`)),
      ["day:Yesterday", "group:t1:1", "day:Today", "group:t1:2,3", "group:t2:4", "group:null:5"],
    );
    const first = rows[1];
    assert.ok(first && first.kind === "group");
    assert.equal((first.items[0]!.item as { label: string }).label, "lead created the task");
  });

  it("leaves run starts and a task's opening brief to the thread, and names non-task groups", () => {
    const events = new Map<string, BoardEvent>([
      ["1", ev("1", "t1", new Date().toISOString())],
      ["2", { ...ev("2", "t1", new Date().toISOString()), kind: "run.event" }],
      ["3", { ...ev("3", "d1", new Date().toISOString(), maya), kind: "decision.posted" }],
    ]);
    const rows = buildLog([status("1", "Task created"), msg("1", "Draft the notes"), status("2", "Run started"), status("3", "Decision posted")], events, new Date());
    const groups = rows.filter((r) => r.kind === "group");
    assert.deepEqual(groups.map((g) => g.kind === "group" && [g.topic, g.items.map((i) => i.item.id)]), [
      ["Conversation", ["s-1"]],
      ["Decision", ["s-3"]],
    ]);
  });

  it("keeps a task's creation when its event carries only the brief", () => {
    const events = new Map<string, BoardEvent>([["1", ev("1", "t1", new Date().toISOString())]]);
    const rows = buildLog([msg("1", "Publish the launch blog post")], events, new Date());
    const g = rows.find((r) => r.kind === "group");
    assert.ok(g && g.kind === "group");
    assert.equal((g.items[0]!.item as { label: string }).label, "lead created the task");
  });

  it("drops the server's plain copy of a question", () => {
    const events = new Map<string, BoardEvent>([["1", ev("1", "t1", new Date().toISOString())]]);
    const rows = buildLog([msg("1", "Question (awaiting_approval): Ship it? [options: approve|reject]")], events, new Date());
    assert.deepEqual(rows.filter((r) => r.kind === "group"), []);
  });
});
