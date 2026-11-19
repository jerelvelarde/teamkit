import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolSchema } from "@ag-ui/core/schemas";
import { BOARD_TOOL_NAMES, boardToolDefinitions, isBoardTool } from "../src/board-tools.js";

test("every definition is a valid AG-UI tool with a strict object schema", () => {
  for (const tool of boardToolDefinitions) {
    assert.doesNotThrow(() => ToolSchema.parse(tool), tool.name);
    const params = tool.parameters as { type: string; additionalProperties: boolean; required: string[] };
    assert.equal(params.type, "object");
    assert.equal(params.additionalProperties, false);
    assert.ok(tool.description.length > 0);
  }
});

test("names are unique and equal BOARD_TOOL_NAMES", () => {
  const names = boardToolDefinitions.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names, [...BOARD_TOOL_NAMES]);
});

test("required fields match the spec", () => {
  const required = Object.fromEntries(
    boardToolDefinitions.map((t) => [t.name, (t.parameters as { required: string[] }).required]),
  );
  assert.deepEqual(required, {
    teamkit_create_task: ["room", "brief"],
    teamkit_reply: ["threadId", "text"],
    teamkit_label: ["threadId", "key", "value"],
    teamkit_answer: ["taskId"],
    teamkit_read: ["threadId"],
  });
});

test("teamkit_answer warns that approvals need a person", () => {
  const answer = boardToolDefinitions.find((t) => t.name === "teamkit_answer")!;
  assert.match(answer.description, /approvals need a person and will be refused/);
});

test("isBoardTool", () => {
  assert.equal(isBoardTool("teamkit_read"), true);
  assert.equal(isBoardTool("weather"), false);
});

test("teamkit_create_task describes needs as the ids of tasks it waits on", () => {
  const create = boardToolDefinitions.find((t) => t.name === "teamkit_create_task")!;
  const needs = (create.parameters as { properties: { needs: { description: string } } }).properties.needs;
  assert.equal(needs.description, "Ids of tasks (th_…) that must complete before this one can start.");
  assert.doesNotMatch(create.description, /capabilit/i);
});
