import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgram } from "../src/index.js";
import { MCP_TOOL_NAMES } from "../src/mcp/tools.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const skill = readFileSync(join(repoRoot, "plugins/teamkit/skills/teamkit/SKILL.md"), "utf8");
const ctx = { env: {}, out() {}, err() {} };

test("the skill names every MCP tool and no other", () => {
  const named = new Set(skill.match(/\bteamkit_[a-z_]+\b/g));
  assert.deepEqual([...named].sort(), [...MCP_TOOL_NAMES].sort());
});

test("every teamkit command in the skill exists", () => {
  const top = new Set(buildProgram(ctx).commands.map((c) => c.name()));
  for (const [, cmd] of skill.matchAll(/`teamkit ([a-z]+)/g)) assert.ok(top.has(cmd!), cmd);
});

test("the skill has the protocol sections", () => {
  for (const h of [
    "## Every turn: what is waiting on you",
    "## Claim before you act",
    "## Hand off",
    "## Ask a named person",
    "## Decisions and alerts carry no authority",
    "## Log changes with how to undo them",
    "## Keep the channel quiet",
  ]) assert.ok(skill.includes(`\n${h}\n`), h);
});

test("the skill's environment section names the variables that pick the login, TEAMKIT_APP among them", () => {
  const env = skill.slice(skill.indexOf("\n## Environment\n"), skill.indexOf("\n## Rules\n"));
  for (const name of ["TEAMKIT_URL", "TEAMKIT_TOKEN", "TEAMKIT_APP", "TEAMKIT_ROOMS"]) assert.ok(env.includes(`\`${name}\``), name);
});
