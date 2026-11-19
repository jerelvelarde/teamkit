import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToIR } from "@copilotkit/channels";
import { parseAnswerValue, toSlackMessage } from "../src/slack/blocks.js";
import type { Alert, Decision } from "@copilotkit/teamkit-protocol";
import {
  ANSWER_ACTION_ID,
  AlertCard,
  BlockedCard,
  DecisionCard,
  OutcomeCard,
  StatusCard,
  TaskCard,
  type CardTask,
  type RoomStatus,
} from "../src/slack/cards.js";
import { SLACK_USER } from "./helpers/billing.js";

const task: CardTask = {
  id: "tsk_123",
  room: "build",
  state: "blocked",
  brief: "Ship the release\nsecond line\nthird line\nfourth line",
  url: "http://127.0.0.1:3000/t/tsk_123",
};

const buttons = (blocks: any[]) =>
  blocks.flatMap((b) => (b.type === "actions" ? b.elements.map((e: any) => ({ e, block: b })) : []));
const answerButtons = (blocks: any[]) => buttons(blocks).filter(({ e }) => e.action_id === ANSWER_ACTION_ID);
const allText = (blocks: any[]) => JSON.stringify(blocks);

test("BlockedCard puts each option in its own actions block", () => {
  const { blocks, text } = toSlackMessage(
    BlockedCard({
      task,
      interruptId: "int_1",
      kind: "awaiting_approval",
      question: "Deploy to prod?",
      options: ["approve", "reject"],
      askedBy: "deployer",
    }),
  );
  const found = answerButtons(blocks);
  assert.equal(found.length, 2);
  assert.notEqual(found[0]!.block, found[1]!.block);
  assert.deepEqual(
    found.map(({ e }) => JSON.parse(e.value)),
    [
      { taskId: "tsk_123", interruptId: "int_1", choice: "approve" },
      { taskId: "tsk_123", interruptId: "int_1", choice: "reject" },
    ],
  );
  const header = blocks.find((b) => b.type === "header");
  assert.equal(header.text.text, "Needs approval");
  assert.ok(text.includes("Deploy to prod?"));
  const link = buttons(blocks).find(({ e }) => e.url);
  assert.equal(link!.e.url, task.url);
  assert.equal(link!.e.action_id === ANSWER_ACTION_ID, false);
});

test("BlockedCard without options asks for a thread reply", () => {
  const { blocks } = toSlackMessage(
    BlockedCard({ task, interruptId: "int_1", kind: "awaiting_input", question: "Which env?", options: [] }),
  );
  assert.equal(answerButtons(blocks).length, 0);
  assert.ok(allText(blocks).includes("Reply in this thread to answer."));
  assert.ok(allText(blocks).includes("Needs input"));
  assert.ok(allText(blocks).includes("an agent"));
});

test("an approval without options points to the board, not a thread reply", () => {
  const { blocks } = toSlackMessage(
    BlockedCard({ task, interruptId: "int_1", kind: "awaiting_approval", question: "Ship?", options: [] }),
  );
  assert.equal(answerButtons(blocks).length, 0);
  assert.ok(allText(blocks).includes("Answer this approval on the board."));
  assert.ok(!allText(blocks).includes("Reply in this thread"));
});

test("TaskCard has no answer buttons and links to the board", () => {
  const { blocks } = toSlackMessage(TaskCard({ task }));
  assert.equal(answerButtons(blocks).length, 0);
  const link = buttons(blocks).find(({ e }) => e.url);
  assert.equal(link!.e.url, task.url);
  assert.ok(!allText(blocks).includes("fourth line"));
});

test("OutcomeCard shows the failure reason or an empty marker", () => {
  const failed = toSlackMessage(OutcomeCard({ task, outcome: "failed", text: "disk full" }));
  assert.ok(allText(failed.blocks).includes("disk full"));
  assert.ok(allText(failed.blocks).includes("Failed"));
  const empty = toSlackMessage(OutcomeCard({ task, outcome: "completed", text: "  " }));
  assert.ok(allText(empty.blocks).includes("(no result)"));
});

test("rendering is deterministic", () => {
  const a = JSON.stringify(renderToIR(TaskCard({ task })));
  const b = JSON.stringify(renderToIR(TaskCard({ task })));
  assert.equal(a, b);
});

test("agent and person text cannot inject mentions or links", () => {
  const evil = "<!channel> <@U123> <http://evil.test|click> [x](http://evil.test) <!here>";
  const cards = [
    BlockedCard({
      task: { ...task, room: evil, brief: evil },
      interruptId: "i",
      kind: "awaiting_input",
      question: evil,
      options: [],
      askedBy: evil,
    }),
    OutcomeCard({ task, outcome: "failed", text: evil }),
    TaskCard({ task: { ...task, brief: evil } }),
  ];
  for (const card of cards) {
    const { blocks, text } = toSlackMessage(card);
    const mrkdwn = JSON.stringify(
      blocks.flatMap((b) => [b.text, b.fields, b.elements].flat()).filter((x) => x?.type === "mrkdwn"),
    );
    for (const s of [mrkdwn, text]) {
      assert.ok(!/<[!@h]/.test(s), `unescaped markup in ${s}`);
      assert.ok(!s.includes("<http"), s);
    }
  }
});

test("parseAnswerValue", () => {
  const v = { taskId: "t", interruptId: "i", choice: "c" };
  assert.deepEqual(parseAnswerValue(v), v);
  assert.deepEqual(parseAnswerValue(JSON.stringify(v)), v);
  assert.equal(parseAnswerValue("x"), null);
  assert.equal(parseAnswerValue({ taskId: "t", interruptId: "i" }), null);
  assert.equal(parseAnswerValue({ ...v, choice: "" }), null);
  assert.equal(parseAnswerValue(null), null);
});

const prodTask: CardTask = { id: "tsk_p", room: "billing-prod", state: "blocked", brief: "Enable writes on the new invoices table", url: "http://board.test/t/tsk_p" };
const migrationTask: CardTask = { id: "tsk_m", room: "billing-migration", state: "blocked", brief: "Copy the invoices table to the new database", url: "http://board.test/t/tsk_m" };
const ana = { id: "ac_a", name: "ana", kind: "person" } as const;
const anaAgent = { id: "ac_aa", name: "ana-agent", kind: "agent" } as const;
const ben = { id: "ac_b", name: "ben", kind: "person" } as const;
const benAgent = { id: "ac_ba", name: "ben-agent", kind: "agent" } as const;
const sam = { id: "ac_s", name: "sam", kind: "person" } as const;
const samAgent = { id: "ac_sa", name: "sam-agent", kind: "agent" } as const;
const FREEZE = "Freeze writes to the old invoices table from 18:00 UTC.";
const GAP = "Invoice totals differ between the old and new database.";
const confirmed: Alert = {
  id: "alr_1", room: "billing-prod", threadId: "thr_a", text: GAP, level: "confirmed", raisedBy: benAgent,
  confirmedBy: sam, source: sam, resolvedBy: null, resolvedSource: null, resolvedAt: null, createdAt: "2026-11-19T18:02:00.000Z",
};
const suspected: Alert = { ...confirmed, level: "suspected", confirmedBy: null, source: null };

test("an ask names who it waits on and mentions their linked Slack users", () => {
  const m = toSlackMessage(BlockedCard({ task: prodTask, interruptId: "int_1", kind: "awaiting_approval", question: "Approve the cutover write to billing-prod?", options: ["approve", "reject"], askedBy: "ben-agent", waitsOn: ["sam"], mentions: { sam: SLACK_USER.sam } }));
  assert.ok(JSON.stringify(m.blocks).includes("Waiting on <@U0SAM>"));
  assert.equal(m.text, "Needs approval from <@U0SAM>: Approve the cutover write to billing-prod?");
  const anyone = toSlackMessage(BlockedCard({ task: migrationTask, interruptId: "int_2", kind: "awaiting_input", question: "Which batch size?", options: [], waitsOn: null }));
  assert.ok(JSON.stringify(anyone.blocks).includes("Anyone in billing-migration can answer"));
  const bad = toSlackMessage(BlockedCard({ task: prodTask, interruptId: "int_3", kind: "awaiting_approval", question: "Approve?", options: ["approve"], waitsOn: ["sam"], mentions: { sam: "<!channel>" } }));
  assert.ok(!JSON.stringify(bad).includes("<!channel>") && JSON.stringify(bad.blocks).includes("Waiting on sam"));
  const today = toSlackMessage(BlockedCard({ task: prodTask, interruptId: "int_4", kind: "awaiting_approval", question: "Approve?", options: ["approve"] }));
  assert.ok(!allText(today.blocks).includes("Waiting on") && !allText(today.blocks).includes("can answer"));
});

test("DecisionCard shows the decider, the poster when different, and the acknowledgements", () => {
  const d: Decision = { id: "dec_1", room: "billing-migration", threadId: "thr_d", text: FREEZE, decidedBy: ana, postedBy: anaAgent,
    createdAt: "2026-11-19T17:00:00.000Z", acks: [{ actor: benAgent, at: "2026-11-19T17:01:00.000Z" }, { actor: samAgent, at: "2026-11-19T17:02:00.000Z" }] };
  const m = toSlackMessage(DecisionCard({ decision: d }));
  assert.ok(allText(m.blocks).includes("Decided by ana · posted by ana-agent · billing-migration"));
  assert.ok(allText(m.blocks).includes("Acknowledged by ben-agent, sam-agent"));
  assert.equal(m.text, `Decision in billing-migration: ${FREEZE}`);
  const own = toSlackMessage(DecisionCard({ decision: { ...d, postedBy: ana, acks: [] } }));
  assert.ok(allText(own.blocks).includes("Decided by ana · billing-migration"));
  assert.ok(!allText(own.blocks).includes("posted by"));
  assert.ok(allText(own.blocks).includes("No acknowledgements yet"));
});

test("AlertCard is loud with exactly one <!here> only when confirmed and open", () => {
  const loud = toSlackMessage(AlertCard({ alert: confirmed }));
  assert.equal(loud.blocks[0].text.text, "Alert");
  assert.ok(loud.blocks[1].text.text.startsWith("<!here> "));
  assert.equal(loud.text, `<!here> Alert in billing-prod: ${GAP}`);
  assert.ok(allText(loud.blocks).includes("Raised by ben-agent · billing-prod · confirmed by sam"));
  assert.equal(allText(loud.blocks).split("<!here>").length, 2);
  const quiet = toSlackMessage(AlertCard({ alert: suspected }));
  assert.equal(quiet.blocks[0].text.text, "Suspected alert");
  assert.equal(quiet.text, `Suspected alert in billing-prod: ${GAP}`);
  assert.ok(!JSON.stringify(quiet).includes("<!here>"));
  assert.ok(allText(quiet.blocks).includes("Raised by ben-agent · billing-prod"));
});

test("a resolved AlertCard says who resolved it, and for whom, and pings no one", () => {
  const at = "2026-11-19T18:40:00.000Z";
  const bySam = toSlackMessage(AlertCard({ alert: { ...confirmed, resolvedBy: sam, resolvedSource: sam, resolvedAt: at } }));
  assert.equal(bySam.blocks[0].text.text, "Resolved alert");
  assert.equal(bySam.text, `Resolved alert in billing-prod: ${GAP}`);
  assert.match(allText(bySam.blocks), /· Resolved by sam"/);
  assert.ok(!JSON.stringify(bySam).includes("<!here>"));
  const forBen = toSlackMessage(AlertCard({ alert: { ...confirmed, resolvedBy: benAgent, resolvedSource: ben, resolvedAt: at } }));
  assert.match(allText(forBen.blocks), /· Resolved by ben-agent for ben"/);
  const falseAlarm = toSlackMessage(AlertCard({ alert: { ...suspected, resolvedBy: benAgent, resolvedSource: ben, resolvedAt: at } }));
  assert.equal(falseAlarm.blocks[0].text.text, "Resolved alert");
  assert.match(allText(falseAlarm.blocks), /· Resolved by ben-agent for ben"/);
  assert.ok(!JSON.stringify(falseAlarm).includes("<!here>"));
});

test("StatusCard lists agents on, work and asks, and counts open tasks", () => {
  const status: RoomStatus = {
    room: "billing-migration", roomUrl: "http://board.test/?room=billing-migration",
    agentsOn: [{ name: "ana-agent", sessions: 1 }, { name: "ben-agent", sessions: 2 }],
    working: [{ taskId: "tsk_1", brief: "Copy the invoices table to the new database", by: "ben-agent", url: "http://board.test/t/tsk_1" }],
    asks: [
      { taskId: "tsk_2", question: "Approve the cutover write to billing-prod?", waitsOn: ["sam"], url: "http://board.test/t/tsk_2" },
      { taskId: "tsk_3", question: "Which batch size?", waitsOn: null, url: "http://board.test/t/tsk_3" },
    ],
    moreWorking: 0, moreAsks: 3, counts: { ready: 3, waiting: 1, claimed: 2, blocked: 1 },
  };
  const m = toSlackMessage(StatusCard({ status, changedAt: 1_763_560_000_000 }));
  const all = allText(m.blocks);
  assert.equal(m.blocks[0].text.text, "Status · billing-migration");
  for (const s of [
    "*Agents on:* ana-agent, ben-agent (2 sessions)",
    "• ben-agent: <http://board.test/t/tsk_1|Copy the invoices table to the new database>",
    "• sam: <http://board.test/t/tsk_2|Approve the cutover write to billing-prod?>",
    "• anyone: <http://board.test/t/tsk_3|Which batch size?>",
    "• and 3 more on the board",
    "Open tasks: 3 ready · 1 waiting on other tasks · 2 working · 1 waiting on a person",
    "Last change <!date^1763560000^{date_short_pretty} {time}|2025-11-19T13:46:40.000Z> · <http://board.test/?room=billing-migration|Open the board>",
  ]) assert.ok(all.includes(JSON.stringify(s).slice(1, -1)), s);
  const empty = allText(toSlackMessage(StatusCard({ status: { ...status, agentsOn: [], working: [], asks: [], moreAsks: 0 }, changedAt: 1_763_560_000_000 })).blocks);
  for (const s of ["*Agents on:* none right now", "*Working:* nothing claimed", "*Waiting on people:* nothing"]) {
    assert.ok(empty.includes(JSON.stringify(s).slice(1, -1)), s);
  }
});

test("a full StatusCard stays within Slack's limits", () => {
  const long = "Approve the cutover write to billing-prod? ".repeat(10);
  const item = (i: number) => ({ taskId: `tsk_${i}`, question: long, brief: long, by: "ben-agent", waitsOn: ["sam"], url: `http://board.test/t/tsk_${i}` });
  const status: RoomStatus = { room: "billing-prod", roomUrl: "http://board.test/?room=billing-prod", agentsOn: Array.from({ length: 20 }, (_, i) => ({ name: `ben-agent`, sessions: i + 1 })), working: Array.from({ length: 10 }, (_, i) => item(i)), asks: Array.from({ length: 10 }, (_, i) => item(i + 10)), moreWorking: 12, moreAsks: 30, counts: { ready: 5, waiting: 2, claimed: 22, blocked: 40 } };
  const { blocks } = toSlackMessage(StatusCard({ status, changedAt: 1_763_560_000_000 }));
  assert.ok(blocks.length <= 50);
  for (const b of blocks) if (b.text?.text) assert.ok(b.text.text.length <= 3000, `${b.text.text.length}`);
});
