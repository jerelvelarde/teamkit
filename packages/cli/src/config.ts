import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliExit, UsageError } from "./errors.js";

export interface ResolvedConfig {
  url: string;
  token: string;
}

export interface ConfigFile {
  url?: string;
  token?: string;
  adminToken?: string;
}

type Env = Record<string, string | undefined>;

export function configPath(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "teamkit", "config.json");
}

export function readConfigFile(env: Env = process.env): Partial<ConfigFile> {
  const path = configPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Partial<ConfigFile>;
  } catch {
    throw new CliExit(1, `bad config file ${path}`);
  }
}

export function writeConfigFile(patch: Partial<ConfigFile>, env: Env = process.env): void {
  const path = configPath(env);
  const merged = { ...readConfigFile(env), ...patch };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function clearConfigKeys(keys: (keyof ConfigFile)[], env: Env = process.env): void {
  const path = configPath(env);
  try {
    readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  const file = readConfigFile(env);
  for (const k of keys) delete file[k];
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** A config file value, or undefined when it is absent; a non-string value is a UsageError. */
function fileValue(file: Partial<ConfigFile>, key: keyof ConfigFile, env: Env): string | undefined {
  const v: unknown = file[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new UsageError(`${key} in ${configPath(env)} must be a string`);
  return v;
}

export function resolveConfig(opts: { url?: string; token?: string }, env: Env = process.env): ResolvedConfig {
  let url = opts.url || env.TEAMKIT_URL;
  let token = opts.token || env.TEAMKIT_TOKEN;
  // Only read the file for what flags and env did not supply, so a broken file
  // does not stop a command that does not need it.
  if (!url || !token) {
    const file = readConfigFile(env);
    url ||= fileValue(file, "url", env);
    token ||= fileValue(file, "token", env);
  }
  if (!url) throw new UsageError("set TEAMKIT_URL or --url");
  if (!token) throw new UsageError("set TEAMKIT_TOKEN or --token");
  return { url: url.replace(/\/$/, ""), token };
}

/** Like resolveConfig, but for admin commands: it reads only the admin token, never the agent token. */
export function resolveAdminConfig(opts: { url?: string; token?: string }, env: Env = process.env): ResolvedConfig {
  let url = opts.url || env.TEAMKIT_URL;
  let token = opts.token || env.TEAMKIT_ADMIN_TOKEN;
  if (!url || !token) {
    const file = readConfigFile(env);
    url ||= fileValue(file, "url", env);
    token ||= fileValue(file, "adminToken", env);
  }
  if (!url) throw new UsageError("set TEAMKIT_URL or --url");
  if (!token) throw new UsageError("not signed in for admin commands: run `teamkit login` or set TEAMKIT_ADMIN_TOKEN");
  return { url: url.replace(/\/$/, ""), token };
}
