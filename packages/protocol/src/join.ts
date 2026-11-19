/**
 * Rules for the names and emails people give when they join a team. Shared by the server, the
 * CLI and the web board, so it imports nothing from Node.
 */

/** Long enough for `<name>-agent` to fit the 63-character actor name limit. */
export const MAX_JOIN_NAME_LENGTH = 57;
export const MAX_JOIN_LINK_DAYS = 365;
export const MAX_JOIN_LINK_DOMAINS = 20;

const JOIN_NAME = /^[a-z0-9][a-z0-9-]{0,56}$/;
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_DOMAIN_LENGTH = 253;
const MAX_EMAIL_LENGTH = 254;

/** The agent a person connects is named after them: `ana` runs `ana-agent`. */
export function personAgentName(person: string): string {
  return `${person}-agent`;
}

/** Trimmed and lower-cased, or null when it could not name a person and their agent. */
export function normalizeJoinName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return JOIN_NAME.test(name) ? name : null;
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
