import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardError, ERROR_STATUS, errorBody, isBoardError, type ErrorCode } from "../src/errors.js";

const expected: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  task_claimed: 409,
  claim_lost: 409,
  invalid_state: 409,
  approval_requires_person: 403,
  too_large: 413,
};

test("every code maps to its status", () => {
  for (const [code, status] of Object.entries(expected)) {
    assert.equal(ERROR_STATUS[code as ErrorCode], status);
    const e = new BoardError(code as ErrorCode, "m");
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    assert.equal(e.name, "BoardError");
    assert.ok(e instanceof Error);
  }
  assert.equal(Object.keys(ERROR_STATUS).length, 9);
});

test("errorBody shape", () => {
  assert.deepEqual(errorBody(new BoardError("not_found", "no such task")), {
    error: { code: "not_found", message: "no such task" },
  });
});

test("isBoardError", () => {
  assert.equal(isBoardError(new BoardError("forbidden", "x")), true);
  assert.equal(isBoardError(new Error("x")), false);
  assert.equal(isBoardError(null), false);
  assert.equal(isBoardError("BoardError"), false);
  assert.equal(isBoardError({ name: "BoardError", code: "bogus" }), false);
  assert.equal(isBoardError({ name: "BoardError", code: "too_large" }), true);
});
