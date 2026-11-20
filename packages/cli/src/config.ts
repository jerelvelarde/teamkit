import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentApp } from "@copilotkit/teamkit-protocol";
import { CliExit, UsageError } from "./errors.js";

export interface ResolvedConfig {
  url: string;
  token: string;
}

export interface ConfigFile {
  url?: string;
  /** The agent token of a `teamkit join` made without an app (`ana-agent`), and of logins from before apps. */
  token?: string;
  /** One agent token per app on the same server: `ana-claude`'s and `ana-codex`'s. */
  apps?: Partial<Record<AgentApp, string>>;
  adminToken?: string;
}

type Env = Record<string, string | undefined>;

/** Every environment variable that carries an admin credential. `teamkit run` keeps these away from agents. */
export const ADMIN_ENV_KEYS = ["TEAMKIT_ADMIN_TOKEN"] as const;

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
function fileValue(file: Partial<ConfigFile>, key: Exclude<keyof ConfigFile, "apps">, env: Env): string | undefined {
  return stringValue(file[key], key, env);
}

function stringValue(v: unknown, key: string, env: Env): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new UsageError(`${key} in ${configPath(env)} must be a string`);
  return v;
}

/** The app's own saved agent token, or undefined; a malformed `apps` is a UsageError. */
function appToken(file: Partial<ConfigFile>, app: AgentApp, env: Env): string | undefined {
  const apps: unknown = file.apps;
  if (apps === undefined || apps === null) return undefined;
  if (typeof apps !== "object" || Array.isArray(apps)) throw new UsageError(`apps in ${configPath(env)} must be an object`);
  return stringValue((apps as Record<string, unknown>)[app], `apps.${app}`, env);
}

/**
 * The server and agent token: `--token`, then TEAMKIT_TOKEN, then the app's saved token (when
 * `app` is given), then the saved token, which logins from before apps had their own still use.
 */
export function resolveConfig(opts: { url?: string; token?: string; app?: AgentApp }, env: Env = process.env): ResolvedConfig {
  let url = opts.url || env.TEAMKIT_URL;
  let token = opts.token || env.TEAMKIT_TOKEN;
  // Only read the file for what flags and env did not supply, so a broken file
  // does not stop a command that does not need it.
  if (!url || !token) {
    const file = readConfigFile(env);
    url ||= fileValue(file, "url", env);
    if (!token && opts.app) token = appToken(file, opts.app, env);
    token ||= fileValue(file, "token", env);
  }
  if (!url) throw new UsageError("set TEAMKIT_URL or --url");
  if (!token) throw new UsageError("set TEAMKIT_TOKEN or --token");
  return { url: url.replace(/\/$/, ""), token };
}

/**
 * `teamkit run` sets TEAMKIT_TASK and TEAMKIT_CLAIM for the agent it starts. Admin commands refuse to
 * run there, so an agent cannot use the admin login saved in the config file through this tool.
 */
export function refuseInsideRun(env: Env = process.env): void {
  if (env.TEAMKIT_TASK || env.TEAMKIT_CLAIM) {
    throw new UsageError(
      "admin commands are disabled inside `teamkit run` (TEAMKIT_TASK or TEAMKIT_CLAIM is set); run them in your own shell",
    );
  }
}

/** Like resolveConfig, but for admin commands: it reads only the admin token, never the agent token. */
export function resolveAdminConfig(opts: { url?: string; token?: string }, env: Env = process.env): ResolvedConfig {
  refuseInsideRun(env);
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

export interface LogoutTargets {
  url: string;
  /** The admin login saved in the config file: `teamkit logout` removes it once the server has revoked it. */
  fileToken?: string;
  /** A different admin token from --token or TEAMKIT_ADMIN_TOKEN, revoked too. */
  givenToken?: string;
}

/** The admin tokens `teamkit logout` revokes, or null when there are none. */
export function resolveLogoutTargets(opts: { url?: string; token?: string }, env: Env = process.env): LogoutTargets | null {
  refuseInsideRun(env);
  const file = readConfigFile(env);
  const fileToken = fileValue(file, "adminToken", env);
  const given = opts.token || env.TEAMKIT_ADMIN_TOKEN;
  if (!fileToken && !given) return null;
  const url = opts.url || env.TEAMKIT_URL || fileValue(file, "url", env);
  if (!url) throw new UsageError("set TEAMKIT_URL or --url");
  return {
    url: url.replace(/\/$/, ""),
    ...(fileToken ? { fileToken } : {}),
    ...(given && given !== fileToken ? { givenToken: given } : {}),
  };
}
