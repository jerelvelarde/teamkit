import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToIR } from "@copilotkit/channels";
import { parseAnswerValue, toSlackMessage } from "../src/slack/blocks.js";
import { ANSWER_ACTION_ID, BlockedCard, OutcomeCard, TaskCard, type CardTask } from "../src/slack/cards.js";

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
