import assert from "node:assert/strict";
import { test } from "node:test";
import { hashToken, newId, newTokenSecret } from "../src/ids.js";

test("newId matches prefix + 16 hex", () => {
  assert.match(newId("th"), /^th_[0-9a-f]{16}$/);
});

test("newTokenSecret format", () => {
  assert.match(newTokenSecret(), /^tk_[A-Za-z0-9_-]{43}$/);
});

test("1000 ids are unique", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => newId("th")));
  assert.equal(ids.size, 1000);
});

test("hashToken is 64 hex and deterministic", () => {
  const h = hashToken("tk_abc");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, hashToken("tk_abc"));
});
