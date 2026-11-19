import type { Command } from "commander";
import {
  createAdminClient,
  startDeviceLogin,
  TeamkitError,
  waitForDeviceLogin,
} from "@copilotkit/teamkit-client";
import { clearConfigKeys, readConfigFile, resolveAdminConfig, writeConfigFile } from "../config.js";
import { globalOpts, type CliContext } from "../context.js";
import { CliExit, UsageError } from "../errors.js";

export function registerLogin(program: Command, ctx: CliContext): void {
  program
    .command("login")
    .description("sign in as an admin with a code you confirm on the web board")
    .action(async (_opts: unknown, cmd: Command) => {
      const { url: urlFlag, json } = globalOpts(cmd);
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
    .description("sign out of the admin login on this machine")
    .action(async (_opts: unknown, cmd: Command) => {
      const { url, token } = globalOpts(cmd);
      let cfg;
      try {
        cfg = resolveAdminConfig({ url, token }, ctx.env);
      } catch (e) {
        if (e instanceof UsageError && /not signed in/.test(e.message)) {
          ctx.out("Not signed in");
          return;
        }
        throw e;
      }
      try {
        await createAdminClient(cfg).logout();
      } catch (e) {
        if (e instanceof TeamkitError && e.status === 401) {
          // Already invalid on the server; nothing to revoke.
        } else {
          ctx.err("warning: could not reach the server to end this login; clearing it locally");
        }
      }
      clearConfigKeys(["adminToken"], ctx.env);
      ctx.out("Signed out");
    });
}
