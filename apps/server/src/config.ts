export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  reapIntervalMs: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = intVar(env, "PORT", 8787, 0);
  if (port > 65535) throw new Error(`PORT must be at most 65535, got "${env.PORT}"`);
  return {
    databaseUrl: env.DATABASE_URL || "postgres://teamkit@127.0.0.1:54329/teamkit",
    port,
    host: env.HOST || "0.0.0.0",
    reapIntervalMs: intVar(env, "TEAMKIT_REAP_INTERVAL_MS", 15000, 1),
  };
}
