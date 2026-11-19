import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BIN = fileURLToPath(new URL("../../bin/teamkit.mjs", import.meta.url));

export function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("TEAMKIT_")),
  );
  env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "teamkit-cfg-"));
  env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "teamkit-state-"));
  return { ...env, ...extra };
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { timeoutMs?: number; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 30000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    // The child may exit before reading stdin; ignore EPIPE.
    child.stdin.on("error", () => {});
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

export function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  opts?: { timeoutMs?: number; input?: string },
): Promise<RunResult> {
  return runNode([BIN, ...args], env, opts);
}

export function spawnCli(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [BIN, ...args], { env, stdio: "pipe" });
}
