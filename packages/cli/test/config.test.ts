import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, readConfigFile, resolveConfig, writeConfigFile } from "../src/config.js";
import { CliExit, UsageError } from "../src/errors.js";

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "tk-cfg-")), ...extra };
}

test("flags beat env beat config file", () => {
  const e = env({ TEAMKIT_URL: "http://env", TEAMKIT_TOKEN: "env-tok" });
  writeConfigFile({ url: "http://file", token: "file-tok" }, e);
  assert.deepEqual(resolveConfig({ url: "http://flag", token: "flag-tok" }, e), { url: "http://flag", token: "flag-tok" });
  assert.deepEqual(resolveConfig({}, e), { url: "http://env", token: "env-tok" });
  const f = env();
  writeConfigFile({ url: "http://file", token: "file-tok" }, f);
  assert.deepEqual(resolveConfig({}, f), { url: "http://file", token: "file-tok" });
});

test("trailing slash is stripped from the url", () => {
  assert.equal(resolveConfig({ url: "http://x/", token: "t" }, env()).url, "http://x");
});

test("missing url or token gives UsageError with code 2", () => {
  assert.throws(
    () => resolveConfig({ url: "http://x" }, env()),
    (e: unknown) => e instanceof UsageError && e.code === 2 && e.message === "set TEAMKIT_TOKEN or --token",
  );
  assert.throws(
    () => resolveConfig({ token: "t" }, env()),
    (e: unknown) => e instanceof UsageError && e.message === "set TEAMKIT_URL or --url",
  );
});

test("missing config file reads as empty; malformed exits 1", () => {
  const e = env();
  assert.deepEqual(readConfigFile(e), {});
  mkdirSync(join(e.XDG_CONFIG_HOME, "teamkit"));
  writeFileSync(configPath(e), "{nope");
  assert.throws(
    () => readConfigFile(e),
    (err: unknown) => err instanceof CliExit && err.code === 1 && err.message === `bad config file ${configPath(e)}`,
  );
});

test("writeConfigFile merges and leaves the file at 0600", () => {
  const e = env();
  writeConfigFile({ url: "http://a" }, e);
  writeConfigFile({ token: "t" }, e);
  assert.deepEqual(readConfigFile(e), { url: "http://a", token: "t" });
  assert.equal(statSync(configPath(e)).mode & 0o777, 0o600);
  assert.equal(statSync(join(e.XDG_CONFIG_HOME, "teamkit")).mode & 0o777, 0o700);
});

function writeRaw(e: Record<string, string>, raw: string): void {
  mkdirSync(join(e.XDG_CONFIG_HOME!, "teamkit"), { recursive: true });
  writeFileSync(configPath(e), raw);
}

test("a malformed config file is not read when flags or env supply url and token", () => {
  const e = env();
  writeRaw(e, "{nope");
  assert.deepEqual(resolveConfig({ url: "http://flag", token: "flag-tok" }, e), { url: "http://flag", token: "flag-tok" });
  const withEnv = { ...e, TEAMKIT_URL: "http://env", TEAMKIT_TOKEN: "env-tok" };
  assert.deepEqual(resolveConfig({}, withEnv), { url: "http://env", token: "env-tok" });
  assert.throws(
    () => resolveConfig({ url: "http://flag" }, e),
    (err: unknown) => err instanceof CliExit && err.code === 1 && err.message === `bad config file ${configPath(e)}`,
  );
});

test("a non-string config value is a UsageError only when it is needed", () => {
  const e = env();
  writeRaw(e, JSON.stringify({ url: 1, token: "file-tok" }));
  assert.throws(
    () => resolveConfig({}, e),
    (err: unknown) => err instanceof UsageError && err.code === 2 && err.message === `url in ${configPath(e)} must be a string`,
  );
  assert.deepEqual(resolveConfig({ url: "http://flag" }, e), { url: "http://flag", token: "file-tok" });
  writeRaw(e, JSON.stringify({ url: "http://file", token: { nested: true } }));
  assert.throws(
    () => resolveConfig({}, e),
    (err: unknown) => err instanceof UsageError && err.message === `token in ${configPath(e)} must be a string`,
  );
  assert.deepEqual(resolveConfig({ token: "flag-tok" }, e), { url: "http://file", token: "flag-tok" });
});
