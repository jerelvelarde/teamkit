import assert from "node:assert/strict";
import { test } from "node:test";
import { exitCodeFor, parseDuration, parseKeyValue, parseLabels } from "../src/args.js";
import { CliExit, UsageError } from "../src/errors.js";

test("parseDuration handles each unit and bare seconds", () => {
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("10"), 10_000);
  assert.throws(() => parseDuration("abc"), UsageError);
});

test("parseKeyValue splits at the first =", () => {
  assert.deepEqual(parseKeyValue("a=b=c"), ["a", "b=c"]);
  assert.deepEqual(parseKeyValue("a="), ["a", ""]);
  assert.throws(() => parseKeyValue("bad"), (e: unknown) => e instanceof UsageError && e.code === 2);
  assert.throws(() => parseKeyValue("=v"), UsageError);
});

test("parseLabels", () => {
  assert.equal(parseLabels(undefined), undefined);
  assert.equal(parseLabels([]), undefined);
  assert.deepEqual(parseLabels(["a=1", "b=2=3"]), { a: "1", b: "2=3" });
});

test("exitCodeFor maps errors to exit codes", () => {
  assert.deepEqual(exitCodeFor(new CliExit(3, "x")), { code: 3, message: "x" });
  assert.deepEqual(exitCodeFor(new UsageError("u")), { code: 2, message: "u" });
  assert.deepEqual(exitCodeFor({ code: "claim_lost", status: 409, message: "m" }), {
    code: 1,
    message: "error: claim_lost: m",
  });
  assert.deepEqual(exitCodeFor(new Error("boom")), { code: 1, message: "error: boom" });
  assert.deepEqual(exitCodeFor("s"), { code: 1, message: "error: s" });
});
