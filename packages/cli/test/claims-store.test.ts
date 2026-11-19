import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { claimsPath, forgetClaim, loadClaims, resolveClaimId, saveClaim } from "../src/claims-store.js";
import { UsageError } from "../src/errors.js";

function freshEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "teamkit-claims-")), ...extra };
}

test("claimsPath uses XDG_STATE_HOME", () => {
  const env = freshEnv();
  assert.equal(claimsPath(env), join(env.XDG_STATE_HOME!, "teamkit", "claims.json"));
});

test("save, load and forget", () => {
  const env = freshEnv();
  assert.deepEqual(loadClaims(env), {});
  saveClaim("t1", "c1", env);
  saveClaim("t2", "c2", env);
  assert.deepEqual(loadClaims(env), { t1: "c1", t2: "c2" });
  forgetClaim("t1", env);
  assert.deepEqual(loadClaims(env), { t2: "c2" });
});

test("file is 0600 and dir is 0700", () => {
  const env = freshEnv();
  saveClaim("t1", "c1", env);
  assert.equal(statSync(claimsPath(env)).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(claimsPath(env))).mode & 0o777, 0o700);
});

test("malformed file loads as empty", () => {
  const env = freshEnv();
  mkdirSync(dirname(claimsPath(env)), { recursive: true });
  writeFileSync(claimsPath(env), "{not json");
  assert.deepEqual(loadClaims(env), {});
  writeFileSync(claimsPath(env), "[1]");
  assert.deepEqual(loadClaims(env), {});
});

test("resolveClaimId precedence", () => {
  const env = freshEnv({ TEAMKIT_CLAIM: "envc", TEAMKIT_TASK: "t1" });
  saveClaim("t1", "stored", env);
  assert.equal(resolveClaimId("t1", { claim: "flag" }, env), "flag");
  assert.equal(resolveClaimId("t1", {}, env), "envc");
  const other = { ...env, TEAMKIT_TASK: "t9" };
  assert.equal(resolveClaimId("t1", {}, other), "stored");
});

test("unknown task throws UsageError", () => {
  const env = freshEnv({ TEAMKIT_CLAIM: "envc", TEAMKIT_TASK: "t9" });
  assert.throws(() => resolveClaimId("t1", {}, env), (e: unknown) => e instanceof UsageError && /no claim known for t1; pass --claim/.test(e.message));
});
