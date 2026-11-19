import type { Command } from "commander";
import type { TeamkitClient } from "@copilotkit/teamkit-client";
import type { CliContext } from "./context.js";

export type RunTarget = { taskId: string } | { room: string; labels?: Record<string, string>; waitMs: number };

export interface RunTaskOptions {
  client: TeamkitClient;
  url: string;
  token: string;
  target: RunTarget;
  command: string[];
  renewEveryMs?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  handleSignals?: boolean;
}

export async function runTask(_opts: RunTaskOptions): Promise<number> {
  throw new Error("not implemented");
}

export function registerRun(_program: Command, _ctx: CliContext): void {}
