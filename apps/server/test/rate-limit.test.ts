import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenBucket } from "../src/http/rate-limit.js";

test("a bucket allows a burst, then refills at its rate, per key", () => {
  let now = 0;
  const b = tokenBucket({ burst: 2, perMinute: 6 }, () => now); // one token per 10 s
  assert.equal(b.take("a"), 0);
  assert.equal(b.take("a"), 0);
  assert.equal(b.take("a"), 10_000, "empty: the next token is 10 s away");
  assert.equal(b.take("b"), 0, "another key has its own bucket");
  now += 4_000;
  assert.equal(b.take("a"), 6_000);
  now += 6_000;
  assert.equal(b.take("a"), 0);
  now += 3_600_000;
  assert.equal(b.take("a"), 0);
  assert.equal(b.take("a"), 0);
  assert.ok(b.take("a") > 0, "a long wait refills only up to the burst");
});

test("a bucket keeps a bounded number of keys", () => {
  let now = 0;
  const b = tokenBucket({ burst: 1, perMinute: 1 }, () => now);
  for (let i = 0; i < 10_000; i++) b.take(`k${i}`);
  b.take("k0"); // k0 is now the most recently used, k1 the least
  b.take("new"); // the map is full: k1 is dropped to make room
  assert.equal(b.take("k1"), 0, "a dropped key starts over with a full bucket");
  assert.ok(b.take("k0") > 0, "a recently used key is still tracked");
  assert.ok(b.take("k9999") > 0);
});
