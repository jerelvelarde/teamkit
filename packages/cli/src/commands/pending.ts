import type { Command } from "commander";
import { createClient, TeamkitError, type TeamkitClient } from "@copilotkit/teamkit-client";
import { clientFor, configFor, globalOpts, type CliContext } from "../context.js";
import { CliExit, UsageError } from "../errors.js";
import { formatPending } from "../format.js";

/** How long `pending --brief` waits for the server before giving up. */
export const BRIEF_TIMEOUT_MS = 5_000;

/**
 * `teamkit pending --brief` runs from agent hooks before every prompt. A hook that exits 2 drops
 * the person's prompt, so this path never exits 2: no login or nothing waiting prints nothing and
 * exits 0; any other failure prints one line on stderr and exits 1, within about 5 s.
 */
async function brief(cmd: Command, ctx: CliContext): Promise<void> {
  let client: TeamkitClient;
  let token: string | undefined;
  try {
    const config = configFor(cmd, ctx);
    token = config.token;
    client = createClient({ ...config, timeoutMs: BRIEF_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof UsageError) return; // not signed in as an agent: nothing to say
    throw e;
  }
  try {
    const text = formatPending(await client.pending(), { brief: true });
    if (text !== "") ctx.out(text);
  } catch (e) {
    const code = e instanceof TeamkitError ? e.code : "error";
    let message = (e instanceof Error ? e.message : String(e)).split("\n", 1)[0] ?? "";
    if (token) message = message.split(token).join("***");
    throw new CliExit(1, `teamkit pending: ${code}: ${message}`);
  }
}

export function registerPending(program: Command, ctx: CliContext): void {
  program
    .command("pending")
    .description("what is waiting on you: handoffs, answers, decisions, roll calls and asks")
    .option("--brief", "for hooks: print nothing when nothing waits; never exit 2")
    .action(async (o: { brief?: boolean }, cmd: Command) => {
      if (o.brief) return brief(cmd, ctx);
      const p = await clientFor(cmd, ctx).pending();
      if (globalOpts(cmd).json) ctx.out(JSON.stringify(p));
      else ctx.out(formatPending(p, { brief: false }));
    });
}
