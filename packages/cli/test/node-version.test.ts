import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNodeVersion } from "../src/node-version.js";

test("Node 22 and newer pass; older Node gets one clear line", () => {
  assert.equal(checkNodeVersion("22.0.0"), null);
  assert.equal(checkNodeVersion("24.1.0"), null);
  assert.match(checkNodeVersion("20.11.1") ?? "", /needs Node 22 or newer; this is Node 20\.11\.1/);
  assert.equal(checkNodeVersion("20.11.1"),
    "TeamKit needs Node 22 or newer; this is Node 20.11.1. Install Node 22 and make sure the node on your PATH is that version.");
});
