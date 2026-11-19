import type { Command } from "commander";
import { createClient, type TeamkitClient } from "@copilotkit/teamkit-client";
import { resolveConfig, type ResolvedConfig } from "./config.js";

export interface CliContext {
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  err(line: string): void;
}

export function defaultContext(): CliContext {
  return {
    env: process.env,
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
  };
}

export function globalOpts(cmd: Command): { url?: string; token?: string; json: boolean } {
  const o = cmd.optsWithGlobals() as { url?: string; token?: string; json?: boolean };
  return { url: o.url, token: o.token, json: Boolean(o.json) };
}

export function configFor(cmd: Command, ctx: CliContext): ResolvedConfig {
  const { url, token } = globalOpts(cmd);
  return resolveConfig({ url, token }, ctx.env);
}

export function clientFor(cmd: Command, ctx: CliContext): TeamkitClient {
  return createClient(configFor(cmd, ctx));
}

/** Accumulator for repeatable options. Never use variadic options; they swallow positionals. */
export function collect(v: string, prev: string[] = []): string[] {
  return [...prev, v];
}
