import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CustomEventSchema,
  EventSchemas,
  RunErrorEventSchema,
  RunFinishedEventSchema,
  RunStartedEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessageStartEventSchema,
} from "@ag-ui/core/schemas";
import {
  choiceSchema,
  custom,
  runError,
  runFinishedInterrupt,
  runFinishedSuccess,
  runStarted,
  textMessage,
} from "../src/agui.js";

const actor = { id: "ac_1", name: "Ada", kind: "person" as const };

test("textMessage validates and carries actor metadata", () => {
  const [start, content, end] = textMessage({ messageId: "m1", role: "user", text: "hi", actor });
  TextMessageStartEventSchema.parse(start);
  TextMessageContentEventSchema.parse(content);
  TextMessageEndEventSchema.parse(end);
  for (const e of [start, content, end]) {
    EventSchemas.parse(e);
    assert.deepEqual(e.metadata, { teamkit: { actorId: "ac_1", actorName: "Ada", actorKind: "person" } });
  }
  assert.equal(content.delta, "hi");
});

test("custom validates", () => {
  const e = custom("x", { a: 1 });
  CustomEventSchema.parse(e);
  EventSchemas.parse(e);
});

test("runStarted validates and carries claimId", () => {
  const e = runStarted("th_1", "run_1", "cl_1");
  RunStartedEventSchema.parse(e);
  assert.deepEqual((e.metadata as any).teamkit, { claimId: "cl_1" });
});

test("runFinishedSuccess omits null result and still validates", () => {
  const e = runFinishedSuccess("th_1", "run_1", null);
  RunFinishedEventSchema.parse(e);
  assert.ok(!("result" in e));
  const f = runFinishedSuccess("th_1", "run_1", "done");
  RunFinishedEventSchema.parse(f);
  assert.equal(f.result, "done");
  assert.deepEqual(f.outcome, { type: "success" });
});

test("runFinishedInterrupt round-trips responseSchema", () => {
  const responseSchema = choiceSchema(["approve", "reject"]);
  const e = runFinishedInterrupt("th_1", "run_1", {
    id: "in_1",
    reason: "awaiting_approval",
    message: "ok?",
    responseSchema,
  });
  const parsed = RunFinishedEventSchema.parse(e) as any;
  assert.equal(parsed.outcome.type, "interrupt");
  assert.deepEqual(parsed.outcome.interrupts[0].responseSchema, responseSchema);
  const bare = runFinishedInterrupt("th_1", "run_1", { id: "in_2", reason: "needs_input", message: "?" });
  RunFinishedEventSchema.parse(bare);
  assert.ok(!("responseSchema" in (bare.outcome as any).interrupts[0]));
});

test("runError validates", () => {
  const e = runError("boom", "E1");
  RunErrorEventSchema.parse(e);
  EventSchemas.parse(e);
});

test("choiceSchema shape", () => {
  assert.deepEqual(choiceSchema(["a", "b"]), {
    type: "object",
    properties: { choice: { type: "string", enum: ["a", "b"] } },
    required: ["choice"],
  });
});
