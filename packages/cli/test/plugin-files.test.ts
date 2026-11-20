import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { writeConfigFile } from "../src/config.js";
import { isolatedEnv } from "./helpers/cli.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const pluginRoot = join(repoRoot, "plugins/teamkit");
const json = (p: string) => JSON.parse(readFileSync(join(repoRoot, p), "utf8"));
const fixture = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/agent-plugins-1.0.0/${f}`, import.meta.url), "utf8"));
const cliVersion = (json("packages/cli/package.json") as { version: string }).version;
const HOOK = { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/teamkit.mjs" pending --brief', timeout: 10 };
const DESCRIPTION =
  "Work with your team's agents on a TeamKit board: see what is waiting on you, claim work, hand off, ask a named person, and record decisions and changes.";

/** The `key: value` lines of a SKILL.md's front matter. */
function frontmatter(path: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path, "utf8"));
  assert.ok(m, `${path} has front matter`);
  const out: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

function hookCommand(): string {
  return (json("plugins/teamkit/hooks/hooks.json") as { hooks: { SessionStart: { hooks: { command: string }[] }[] } })
    .hooks.SessionStart[0]!.hooks[0]!.command;
}

test("the Codex manifest and MCP config match the Agent Plugins 1.0.0 schemas", () => {
  const ajv = new Ajv2020({ strict: false });
  for (const [file, schema] of [["plugins/teamkit/plugin.json", "plugin.schema.json"], ["plugins/teamkit/mcp.json", "mcp.schema.json"]] as const) {
    const validate = ajv.compile(fixture(schema));
    assert.ok(validate(json(file)), `${file}: ${JSON.stringify(validate.errors)}`);
  }
});

test("both manifests name teamkit and carry the CLI's version", () => {
  for (const file of ["plugins/teamkit/.claude-plugin/plugin.json", "plugins/teamkit/plugin.json"]) {
    const m = json(file) as { name: string; version: string; description: string };
    assert.deepEqual([m.name, m.version, m.description], ["teamkit", cliVersion, DESCRIPTION], file);
  }
});

test("both MCP configs start the bundled CLI's mcp command as their own app's agent", () => {
  const claudeMcp = json("plugins/teamkit/.mcp.json") as { mcpServers: Record<string, unknown> };
  const codexMcp = json("plugins/teamkit/mcp.json") as { mcpServers: Record<string, unknown> };
  assert.deepEqual(claudeMcp.mcpServers.teamkit, {
    command: "node",
    args: ["${CLAUDE_PLUGIN_ROOT}/bin/teamkit.mjs", "mcp", "--app", "claude"],
  });
  assert.deepEqual(codexMcp.mcpServers.teamkit, {
    type: "stdio",
    command: "node",
    args: ["${PLUGIN_ROOT}/bin/teamkit.mjs", "mcp", "--app", "codex"],
  });
});

test("hooks run pending --brief on SessionStart and UserPromptSubmit", () => {
  const hooks = (json("plugins/teamkit/hooks/hooks.json") as { hooks: Record<string, { hooks: unknown[] }[]> }).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["SessionStart", "UserPromptSubmit"]);
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    assert.deepEqual(hooks[event], [{ hooks: [HOOK] }], event);
  }
});

test("the hook command is silent on a machine that never joined", () => {
  const r = spawnSync("sh", ["-c", hookCommand()], { env: { ...isolatedEnv(), CLAUDE_PLUGIN_ROOT: pluginRoot }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("the hook command reads the login of the app whose folder holds the plugin", () => {
  // Installed under .claude, the hook uses the claude login: here a server that is down, so it exits 1.
  const installed = join(mkdtempSync(join(tmpdir(), "teamkit-plugin-")), ".claude", "plugins", "teamkit");
  mkdirSync(join(installed, "bin"), { recursive: true });
  symlinkSync(join(pluginRoot, "bin", "teamkit.mjs"), join(installed, "bin", "teamkit.mjs"));
  const env = isolatedEnv();
  writeConfigFile({ url: "http://127.0.0.1:9", apps: { claude: "tk_claude_only" } }, env);
  const fromClaude = spawnSync("sh", ["-c", hookCommand()], { env: { ...env, CLAUDE_PLUGIN_ROOT: installed }, encoding: "utf8" });
  assert.deepEqual([fromClaude.status, fromClaude.stdout], [1, ""], fromClaude.stderr);
  assert.ok(!fromClaude.stderr.includes("tk_claude_only"));
  // From a folder that names no app there is no login to use, so it says nothing.
  const elsewhere = spawnSync("sh", ["-c", hookCommand()], { env: { ...env, CLAUDE_PLUGIN_ROOT: pluginRoot }, encoding: "utf8" });
  assert.deepEqual([elsewhere.status, elsewhere.stdout, elsewhere.stderr], [0, "", ""]);
});

test("the hook command gives up on a server that never answers without blocking the prompt", async () => {
  const hang: Server = createServer(() => {});
  await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", resolve));
  const port = (hang.address() as { port: number }).port;
  try {
    const start = Date.now();
    const env = { ...isolatedEnv({ TEAMKIT_URL: `http://127.0.0.1:${port}`, TEAMKIT_TOKEN: "tk_unused" }), CLAUDE_PLUGIN_ROOT: pluginRoot };
    const r = spawnSync("sh", ["-c", hookCommand()], { env, encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.ok(Date.now() - start < 7000);
  } finally {
    hang.close();
  }
});

test("both marketplaces list teamkit at ./plugins/teamkit", () => {
  const claude = json(".claude-plugin/marketplace.json") as {
    name: string; owner: { name: string }; plugins: Record<string, unknown>[];
  };
  assert.equal(claude.name, "teamkit");
  assert.ok(claude.owner.name);
  assert.equal(claude.plugins.length, 1);
  assert.equal(claude.plugins[0]!.name, "teamkit");
  assert.equal(claude.plugins[0]!.source, "./plugins/teamkit");
  assert.ok(!("version" in claude.plugins[0]!));
  const codex = json(".agents/plugins/marketplace.json") as {
    name: string; plugins: { name: string; source: unknown; policy: { installation: string } }[];
  };
  assert.equal(codex.name, "teamkit");
  assert.equal(codex.plugins[0]!.name, "teamkit");
  assert.deepEqual(codex.plugins[0]!.source, { source: "local", path: "./plugins/teamkit" });
  assert.equal(codex.plugins[0]!.policy.installation, "AVAILABLE");
});

test("skills: name matches the folder, description set; join and watch are person-only", () => {
  for (const dir of ["teamkit", "join", "status", "watch"]) {
    const fm = frontmatter(join(pluginRoot, "skills", dir, "SKILL.md"));
    assert.equal(fm.name, dir);
    assert.ok((fm.description ?? "").length > 0, dir);
    assert.equal(fm["disable-model-invocation"] === "true", dir === "join" || dir === "watch", dir);
  }
});

test("everything in the plugin stays inside it; no package.json", () => {
  const root = realpathSync(pluginRoot);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      assert.ok(realpathSync(p).startsWith(root + "/") , p);
      if (lstatSync(p).isDirectory()) walk(p);
    }
  };
  walk(pluginRoot);
  assert.ok(!existsSync(join(pluginRoot, "package.json")));
});

test("the join skill says each app is its own agent, named after the person and the app", () => {
  const text = readFileSync(join(pluginRoot, "skills", "join", "SKILL.md"), "utf8");
  for (const name of ["ana-claude", "ana-codex"]) assert.ok(text.includes(name), name);
});

test("skills/teamkit points at the plugin's copy", () => {
  assert.ok(lstatSync(join(repoRoot, "skills/teamkit")).isSymbolicLink());
  assert.equal(realpathSync(join(repoRoot, "skills/teamkit")), realpathSync(join(pluginRoot, "skills/teamkit")));
});
