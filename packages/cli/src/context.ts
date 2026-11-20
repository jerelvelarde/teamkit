import type { Command } from "commander";
import { createClient, type TeamkitClient } from "@copilotkit/teamkit-client";
import type { AgentApp } from "@copilotkit/teamkit-protocol";
import { resolveApp } from "./app.js";
import { resolveConfig, type ResolvedConfig } from "./config.js";

export interface CliContext {
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  err(line: string): void;
  /** The CLI script's own path (process.argv[1]): installed under `.claude` or `.codex`, it names the app. */
  scriptPath?: string;
}

export function defaultContext(): CliContext {
  return {
    env: process.env,
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
    scriptPath: process.argv[1],
  };
}

export function globalOpts(cmd: Command): { url?: string; token?: string; app?: string; json: boolean } {
  const o = cmd.optsWithGlobals() as { url?: string; token?: string; app?: string; json?: boolean };
  return { url: o.url, token: o.token, app: o.app, json: Boolean(o.json) };
}

/** The app this agent runs in: --app, then TEAMKIT_APP, then the CLI's install path. */
export function appFor(cmd: Command, ctx: CliContext): AgentApp | undefined {
  return resolveApp({ app: globalOpts(cmd).app }, ctx.env, ctx.scriptPath);
}

export function configFor(cmd: Command, ctx: CliContext): ResolvedConfig {
  const { url, token } = globalOpts(cmd);
  return resolveConfig({ url, token, app: appFor(cmd, ctx) }, ctx.env);
}

export function clientFor(cmd: Command, ctx: CliContext): TeamkitClient {
  return createClient(configFor(cmd, ctx));
}

/** Accumulator for repeatable options. Never use variadic options; they swallow positionals. */
export function collect(v: string, prev: string[] = []): string[] {
  return [...prev, v];
}
