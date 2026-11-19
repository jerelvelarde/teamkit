import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildBundle, checkBundle } from "../scripts/bundle.js";
import { isolatedEnv, runNode } from "./helpers/cli.js";
import { mcpTeam } from "./helpers/mcp.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const outFile = () => join(mkdtempSync(join(tmpdir(), "teamkit-bundle-")), "teamkit.mjs");

test("the bundle runs on its own, with no package.json or tsx beside it", async () => {
  const out = outFile();
  await buildBundle(out);
  const r = await runNode([out, "--version"], isolatedEnv());
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), version);
});

test("the bundle is executable, has a node shebang and no build-machine paths", async () => {
  const out = outFile();
  await buildBundle(out);
  const text = readFileSync(out, "utf8");
  assert.ok(text.startsWith("#!/usr/bin/env node\n"));
  assert.notEqual(statSync(out).mode & 0o111, 0);
  assert.ok(!text.includes(repoRoot), "no absolute repo path");
  assert.ok(!text.includes("tsx/esm"));
});

test("a relative outfile is written relative to the caller's directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "teamkit-bundle-rel-"));
  const before = process.cwd();
  process.chdir(dir);
  try {
    await buildBundle("teamkit.mjs");
  } finally {
    process.chdir(before);
  }
  assert.ok(statSync(join(dir, "teamkit.mjs")).isFile());
  assert.ok(!existsSync(join(repoRoot, "teamkit.mjs")), "nothing written at the repo root");
});

test("two builds give identical bytes", async () => {
  const a = outFile();
  const b = outFile();
  await buildBundle(a);
  await buildBundle(b);
  assert.ok(readFileSync(a).equals(readFileSync(b)));
});

test("checkBundle tells a stale file from a fresh one", async () => {
  const out = outFile();
  writeFileSync(out, "garbage");
  assert.deepEqual(await checkBundle(out), { fresh: false });
  await buildBundle(out);
  assert.deepEqual(await checkBundle(out), { fresh: true });
});

test("the bundle serves the 17 tools over stdio", async () => {
  const out = outFile();
  await buildBundle(out);
  const { srv, benToken } = await mcpTeam();
  const env = isolatedEnv({ TEAMKIT_URL: srv.url, TEAMKIT_TOKEN: benToken, TEAMKIT_ROOMS: "billing-migration" });
  const client = new Client({ name: "test", version: "0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [out, "mcp"], env: env as Record<string, string> }));
    assert.equal((await client.listTools()).tools.length, 17);
    const r = await client.callTool({ name: "teamkit_pending", arguments: {} });
    assert.notEqual(r.isError, true, JSON.stringify(r.content));
  } finally {
    await client.close();
    await srv.stop();
  }
});
