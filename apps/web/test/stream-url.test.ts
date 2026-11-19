import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorAfter, streamUrl } from "../lib/stream.ts";

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
