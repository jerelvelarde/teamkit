/**
 * Rules for the names and emails people give when they join a team. Shared by the server, the
 * CLI and the web board, so it imports nothing from Node.
 */

/** The apps a person connects as agents of their own. Each app is its own agent: `ana-claude`, `ana-codex`. */
export const AGENT_APPS = ["claude", "codex"] as const;
export type AgentApp = (typeof AGENT_APPS)[number];

const AGENT_APP_LABELS: Record<AgentApp, string> = { claude: "Claude", codex: "Codex" };

/**
 * Long enough for `<name>-claude`, the longest agent suffix, to fit the 63-character actor name
 * limit (NAME_RE in apps/server/src/store/actors.ts).
 */
export const MAX_JOIN_NAME_LENGTH = 56;
export const MAX_JOIN_LINK_DAYS = 365;
export const MAX_JOIN_LINK_DOMAINS = 20;

const JOIN_NAME = /^[a-z0-9][a-z0-9-]{0,55}$/;
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_DOMAIN_LENGTH = 253;
const MAX_EMAIL_LENGTH = 254;

/** How an agent name ends: `-agent` for an agent connected without an app, or `-<app>`. */
const AGENT_SUFFIXES = ["agent", ...AGENT_APPS].map((s) => `-${s}`);

export function isAgentApp(x: unknown): x is AgentApp {
  return typeof x === "string" && (AGENT_APPS as readonly string[]).includes(x);
}

/** The app's name for people: "Claude" or "Codex". */
export function agentAppLabel(app: AgentApp): string {
  return AGENT_APP_LABELS[app];
}

/**
 * The agent a person connects is named after them and the app: `ana` runs `ana-claude` in Claude
 * Code and `ana-codex` in Codex, and `ana-agent` when no app is given.
 */
export function personAgentName(person: string, app?: AgentApp): string {
  return `${person}-${app ?? "agent"}`;
}

/** True for a name only an agent may carry: a person named `ben-codex` would take ben's agent's name. */
export function isAgentStyleName(name: string): boolean {
  return AGENT_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function listOf(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

export const AGENT_STYLE_NAME_ERROR = `a person's name cannot end in ${listOf(AGENT_SUFFIXES)}; that is how agent names end`;

/** Trimmed and lower-cased, or null when it could not name a person and their agent. */
export function normalizeJoinName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return JOIN_NAME.test(name) && !isAgentStyleName(name) ? name : null;
}

/** Trimmed, lower-cased and without one leading `@`; null unless it has two or more valid labels. */
export function normalizeDomain(raw: string): string | null {
  let domain = raw.trim().toLowerCase();
  if (domain.startsWith("@")) domain = domain.slice(1);
  if (domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => DOMAIN_LABEL.test(l))) return null;
  return domain;
}

/** Trimmed and lower-cased, or null when it is not one address with a valid domain. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null;
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || /\s/.test(local)) return null;
  return normalizeDomain(domain) === domain ? email : null;
}

/** The part after the `@` of an address `normalizeEmail` accepted. */
export function emailDomain(email: string): string {
  return email.slice(email.indexOf("@") + 1);
}
