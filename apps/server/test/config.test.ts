import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("host defaults to loopback and HOST overrides it", () => {
  assert.equal(loadConfig({}).host, "127.0.0.1");
  assert.equal(loadConfig({ HOST: "0.0.0.0" }).host, "0.0.0.0");
});

test("TEAMKIT_PUBLIC_URL rejects an empty or invalid port", () => {
  for (const bad of ["http://localhost:", "http://localhost:/", "https://b.example.com:?x=1", "http://localhost:99999", "http://localhost:abc"]) {
    assert.throws(() => loadConfig({ TEAMKIT_PUBLIC_URL: bad }), /TEAMKIT_PUBLIC_URL/, bad);
  }
  assert.equal(loadConfig({ TEAMKIT_PUBLIC_URL: "http://localhost:3000/" }).publicUrl, "http://localhost:3000");
  assert.equal(loadConfig({ TEAMKIT_PUBLIC_URL: "http://[::1]:3000" }).publicUrl, "http://[::1]:3000");
});
