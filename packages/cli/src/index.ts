import { readFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { exitCodeFor } from "./args.js";
import { defaultContext, type CliContext } from "./context.js";
import { registerAdmin } from "./commands/admin.js";
import { registerDecisions } from "./commands/decisions.js";
import { registerHandoff } from "./commands/handoff.js";
import { registerPresence } from "./commands/presence.js";
import { registerRollCall } from "./commands/rollcall.js";
import { registerJoin } from "./commands/join.js";
import { registerLogin } from "./commands/login.js";
import { registerPost } from "./commands/post.js";
import { registerRead } from "./commands/read.js";
import { registerTasks } from "./commands/tasks.js";
import { registerWait } from "./commands/wait.js";
import { registerWhoami } from "./commands/whoami.js";
import { registerRun } from "./run.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export function buildProgram(ctx: CliContext): Command {
  const program = new Command("teamkit")
    .description("TeamKit command-line tool")
    .version(version)
    .option("--url <u>", "TeamKit server URL")
    .option("--token <t>", "TeamKit API token")
    .option("--json", "machine-readable output")
    .exitOverride();
  registerWhoami(program, ctx);
  registerRead(program, ctx);
  registerPost(program, ctx);
  registerWait(program, ctx);
  registerTasks(program, ctx);
  registerHandoff(program, ctx);
  registerDecisions(program, ctx);
  registerRollCall(program, ctx);
  registerPresence(program, ctx);
  registerRun(program, ctx);
  registerLogin(program, ctx);
  registerJoin(program, ctx);
  registerAdmin(program, ctx);
  return program;
}

export async function main(argv: string[], overrides: Partial<CliContext> = {}): Promise<number> {
  const ctx: CliContext = { ...defaultContext(), ...overrides };
  try {
    await buildProgram(ctx).parseAsync(argv);
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      return e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help"
        ? 0
        : 2;
    }
    const { code, message } = exitCodeFor(e);
    if (message) {
      const errCode = (e as { code?: unknown }).code;
      ctx.err(
        argv.includes("--json")
          ? JSON.stringify({
              error: {
                code: typeof errCode === "string" ? errCode : "error",
                message: message.replace(`error: ${typeof errCode === "string" ? `${errCode}: ` : ""}`, ""),
              },
            })
          : message,
      );
    }
    return code;
  }
}
