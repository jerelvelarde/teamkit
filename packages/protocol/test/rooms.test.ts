import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidRoom, roomMatches, isValidRoomPattern } from "../src/rooms.js";

test("isValidRoom accepts valid names", () => {
  assert.equal(isValidRoom("build"), true);
  assert.equal(isValidRoom("work/checkout"), true);
});

test("isValidRoom rejects invalid names", () => {
  for (const n of ["Build", "", "a//b", "-x", "a/b/c/d/e/f"]) {
    assert.equal(isValidRoom(n), false, n);
  }
});

test("roomMatches", () => {
  assert.equal(roomMatches("build/", "build"), true);
  assert.equal(roomMatches("build/", "build/x"), true);
  assert.equal(roomMatches("build/", "builder"), false);
  assert.equal(roomMatches("*", "anything"), true);
  assert.equal(roomMatches("build", "build/x"), false);
});

test("isValidRoomPattern", () => {
  assert.equal(isValidRoomPattern("*"), true);
  assert.equal(isValidRoomPattern("build/"), true);
  assert.equal(isValidRoomPattern("build//"), false);
  assert.equal(isValidRoomPattern("/"), false);
});
