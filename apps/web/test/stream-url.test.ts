import assert from "node:assert/strict";
import { test } from "node:test";
import { afterFailure, cursorAfter, resumeCursor, retryDelayMs, streamUrl } from "../lib/stream";

test("streamUrl puts room, thread, after, then repeated kinds", () => {
  assert.equal(
    streamUrl({ room: "build", kinds: ["task.created", "task.ready"] }),
    "/v1/events/stream?room=build&kind=task.created&kind=task.ready",
  );
  assert.equal(streamUrl({ thread: "th_1", after: "42" }), "/v1/events/stream?thread=th_1&after=42");
  assert.equal(streamUrl({}), "/v1/events/stream");
});

test("cursorAfter compares decimal cursors as integers", () => {
  assert.equal(cursorAfter("5", undefined), true);
  assert.equal(cursorAfter("10", "9"), true);
  assert.equal(cursorAfter("9", "10"), false);
  assert.equal(cursorAfter("10", "10"), false);
});

test("retryDelayMs doubles from 2 s and stops at 60 s", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 50, 5000].map(retryDelayMs), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]);
});

test("resumeCursor reopens after the later of the last delivered event and the starting cursor", () => {
  assert.equal(resumeCursor(undefined, undefined), undefined, "a live tail with nothing delivered stays a live tail");
  assert.equal(resumeCursor(undefined, "40"), "40");
  assert.equal(resumeCursor("41", undefined), "41");
  assert.equal(resumeCursor("41", "40"), "41");
  assert.equal(resumeCursor("41", "100"), "100", "a refetch the caller merged moves the start forward");
});

test("afterFailure stops only when the session is gone", () => {
  assert.equal(afterFailure(401), "signed_out");
  assert.equal(afterFailure(403), "signed_out");
  for (const status of [200, 400, 500, 502, 503, null]) assert.equal(afterFailure(status), "retry", String(status));
});
