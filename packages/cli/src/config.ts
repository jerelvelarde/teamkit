import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliExit, UsageError } from "./errors.js";

export interface ResolvedConfig {
  url: string;
  token: string;
}

type Env = Record<string, string | undefined>;

export function configPath(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "teamkit", "config.json");
}

export function readConfigFile(env: Env = process.env): Partial<ResolvedConfig> {
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
    return parsed as Partial<ResolvedConfig>;
  } catch {
    throw new CliExit(1, `bad config file ${path}`);
  }
}

export function writeConfigFile(patch: Partial<ResolvedConfig>, env: Env = process.env): void {
  const path = configPath(env);
  const merged = { ...readConfigFile(env), ...patch };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function resolveConfig(opts: { url?: string; token?: string }, env: Env = process.env): ResolvedConfig {
  const file = readConfigFile(env);
  const url = opts.url || env.TEAMKIT_URL || file.url;
  const token = opts.token || env.TEAMKIT_TOKEN || file.token;
  if (!url) throw new UsageError("set TEAMKIT_URL or --url");
  if (!token) throw new UsageError("set TEAMKIT_TOKEN or --token");
  return { url: url.replace(/\/$/, ""), token };
}
