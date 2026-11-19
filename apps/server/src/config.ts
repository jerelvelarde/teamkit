import { slackBridgeConfigFromEnv, type SlackBridgeConfig } from "./slack/bridge-config.js";
import { DEFAULT_PUBLIC_URL } from "./store/people.js";

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  reapIntervalMs: number;
  /** The web board's public origin, no trailing slash; used for links shown to people. */
  publicUrl: string;
  slack: {
    bridge: SlackBridgeConfig;
    /** SLACK_BOT_TOKEN; Slack outbound starts only when it is set. */
    botToken?: string;
    apiBase: string;
  };
}

function intVar(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return n;
}

function publicUrlVar(env: NodeJS.ProcessEnv): string {
  const raw = env.TEAMKIT_PUBLIC_URL;
  if (raw === undefined || raw === "") return DEFAULT_PUBLIC_URL;
  let ok = false;
  try {
    const u = new URL(raw);
    ok = u.protocol === "http:" || u.protocol === "https:";
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`TEAMKIT_PUBLIC_URL must be an http(s) URL, got "${raw}"`);
  return raw.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = intVar(env, "PORT", 8787, 0);
  if (port > 65535) throw new Error(`PORT must be at most 65535, got "${env.PORT}"`);
  const publicUrl = publicUrlVar(env);
  return {
    databaseUrl: env.DATABASE_URL || "postgres://teamkit@127.0.0.1:54329/teamkit",
    port,
    host: env.HOST || "0.0.0.0",
    reapIntervalMs: intVar(env, "TEAMKIT_REAP_INTERVAL_MS", 15000, 1),
    publicUrl,
    slack: {
      bridge: slackBridgeConfigFromEnv(env, publicUrl),
      botToken: env.SLACK_BOT_TOKEN || undefined,
      apiBase: env.SLACK_API_BASE || "https://slack.com/api",
    },
  };
}
