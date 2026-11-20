import { AGENT_APPS, isAgentApp, type AgentApp } from "@copilotkit/teamkit-protocol";
import { UsageError } from "./errors.js";

type Env = Record<string, string | undefined>;

/** The folder each app installs its plugins under, as it appears in the CLI's own path. */
const APP_FOLDERS: Record<AgentApp, string> = { claude: "/.claude/", codex: "/.codex/" };

/**
 * The app whose plugin folder holds the CLI script at `path`: a path inside `.claude` is Claude
 * Code's, one inside `.codex` is Codex's. When both appear, the folder nearest the script wins.
 */
export function appFromPath(path: string | undefined): AgentApp | undefined {
  if (!path) return undefined;
  const p = path.replace(/\\/g, "/");
  let found: AgentApp | undefined;
  let at = -1;
  for (const app of AGENT_APPS) {
    const i = p.lastIndexOf(APP_FOLDERS[app]);
    if (i > at) [found, at] = [app, i];
  }
  return found;
}

function checked(value: string, where: string): AgentApp {
  if (!isAgentApp(value)) throw new UsageError(`${where} must be one of ${AGENT_APPS.join(", ")} (got ${value})`);
  return value;
}

/**
 * The app this agent runs in, which picks its saved token: `--app`, then TEAMKIT_APP, then the
 * folder the CLI is installed in (`scriptPath`, normally process.argv[1]); undefined when none
 * says. An unknown `--app` or TEAMKIT_APP is a UsageError.
 */
export function resolveApp(opts: { app?: string }, env: Env, scriptPath?: string): AgentApp | undefined {
  if (opts.app) return checked(opts.app, "--app");
  if (env.TEAMKIT_APP) return checked(env.TEAMKIT_APP, "TEAMKIT_APP");
  return appFromPath(scriptPath);
}
