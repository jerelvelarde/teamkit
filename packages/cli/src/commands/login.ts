import type { Command } from "commander";
import {
  createAdminClient,
  startDeviceLogin,
  TeamkitError,
  waitForDeviceLogin,
} from "@copilotkit/teamkit-client";
import { clearConfigKeys, readConfigFile, refuseInsideRun, resolveLogoutTargets, writeConfigFile } from "../config.js";
import { globalOpts, type CliContext } from "../context.js";
import { CliExit, UsageError } from "../errors.js";

export function registerLogin(program: Command, ctx: CliContext): void {
  program
    .command("login")
    .description("sign in as an admin with a code you confirm on the web board")
    .action(async (_opts: unknown, cmd: Command) => {
      const { url: urlFlag, json } = globalOpts(cmd);
      refuseInsideRun(ctx.env);
      const raw = urlFlag || ctx.env.TEAMKIT_URL || readConfigFile(ctx.env).url;
      if (!raw || typeof raw !== "string") throw new UsageError("set TEAMKIT_URL or --url");
      const url = raw.replace(/\/$/, "");

      const start = await startDeviceLogin(url);
      ctx.err(`To sign in, open ${start.verifyUrl} and confirm code ${start.userCode}`);
      if (json) ctx.out(JSON.stringify({ userCode: start.userCode, verifyUrl: start.verifyUrl }));

      let result;
      try {
        result = await waitForDeviceLogin(url, start);
      } catch (e) {
        if (e instanceof TeamkitError && e.code === "expired") {
          throw new CliExit(1, "login code expired; run `teamkit login` again");
        }
        throw e;
      }
      writeConfigFile({ url, adminToken: result.token }, ctx.env);
      if (json) ctx.out(JSON.stringify({ actor: result.actor }));
      else ctx.out(`Signed in as ${result.actor.name}. This login runs admin commands only.`);
    });

  program
    .command("logout")
    .description("revoke the admin login on this machine, then remove it")
    .action(async (_opts: unknown, cmd: Command) => {
      const { url, token } = globalOpts(cmd);
      const targets = resolveLogoutTargets({ url, token }, ctx.env);
      if (!targets) {
        ctx.out("Not signed in");
        return;
      }
      let failed = false;
      if (targets.fileToken !== undefined) {
        // Remove the saved login only once the server no longer accepts it.
        if (await revoke(targets.url, targets.fileToken, ctx)) clearConfigKeys(["adminToken"], ctx.env);
        else failed = true;
      }
      if (targets.givenToken !== undefined && !(await revoke(targets.url, targets.givenToken, ctx))) failed = true;
      if (failed) throw new CliExit(1, "Could not revoke the admin token; revoke it on the admin page.");
      ctx.out("Signed out");
    });
}

/** Ends an admin login on the server. True when it is revoked now or was already invalid (401). */
async function revoke(url: string, token: string, ctx: CliContext): Promise<boolean> {
  try {
    await createAdminClient({ url, token }).logout();
    return true;
  } catch (e) {
    if (e instanceof TeamkitError && e.status === 401) return true;
    const why = e instanceof TeamkitError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    ctx.err(`teamkit logout: ${why}`);
    return false;
  }
}
