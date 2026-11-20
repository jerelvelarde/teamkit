import { createClient, type TeamkitClient } from "@copilotkit/teamkit-client";
import type { AgentApp } from "@copilotkit/teamkit-protocol";
import { resolveConfig, type ResolvedConfig } from "../config.js";
import { UsageError } from "../errors.js";

export type Env = Record<string, string | undefined>;

export const NOT_SIGNED_IN =
  "This agent is not signed in to TeamKit on this machine. Ask your person to run /teamkit:join <server-url> in Claude Code, the TeamKit join skill in Codex, or `teamkit join <server-url>` in a shell.";

/** The agent has no TeamKit login on this machine (an admin login does not count). */
export class NotSignedInError extends Error {
  constructor() {
    super(NOT_SIGNED_IN);
    this.name = "NotSignedInError";
  }
}

export interface Session {
  /** A client for the current login. Throws NotSignedInError when there is none. */
  client(): TeamkitClient;
}

/** `--url` and `--token`, and the app (already resolved) whose saved token the session reads. */
export interface SessionFlags {
  url?: string;
  token?: string;
  app?: AgentApp;
}

/**
 * Re-reads the CLI's login (flags, then TEAMKIT_URL / TEAMKIT_TOKEN, then the config file: the app's
 * token, then the saved token) on every call, so a `teamkit join` made while the MCP server runs
 * takes effect on the next tool call. It uses only the agent token, never the admin login.
 */
export function createSession(opts: {
  env: Env;
  flags?: SessionFlags;
  makeClient?: (c: ResolvedConfig) => TeamkitClient;
}): Session {
  const make = opts.makeClient ?? ((c: ResolvedConfig) => createClient(c));
  const cache = new Map<string, TeamkitClient>();
  return {
    client() {
      let config: ResolvedConfig;
      try {
        config = resolveConfig(opts.flags ?? {}, opts.env);
      } catch (e) {
        if (e instanceof UsageError) throw new NotSignedInError();
        throw e;
      }
      const key = `${config.url}\n${config.token}`;
      let client = cache.get(key);
      if (!client) {
        client = make(config);
        cache.clear();
        cache.set(key, client);
      }
      return client;
    },
  };
}
