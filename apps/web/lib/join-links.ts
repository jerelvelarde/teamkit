import { normalizeEmail, type JoinLink } from "@copilotkit/teamkit-protocol";

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Email domains from the admin's text: split on commas and spaces, lower-cased, a leading "@"
 * dropped, duplicates removed in order. The server enforces its own caps.
 */
export function parseDomains(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const d = raw.trim().toLowerCase().replace(/^@/, "");
    if (d === "") continue;
    if (!DOMAIN.test(d)) throw new Error(`"${d}" is not an email domain, like example.com.`);
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** Days until a join link expires: empty for never, else a whole number of 1 or more. */
export function parseDays(text: string): number | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  if (!/^\d+$/.test(t) || Number(t) < 1) throw new Error("Expiry must be a whole number of days, 1 or more.");
  return Number(t);
}

/** A revoked link is revoked whatever its expiry; otherwise expired at or after `expiresAt`. */
export function joinLinkStatus(link: JoinLink, now: number): "active" | "expired" | "revoked" {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && Date.parse(link.expiresAt) <= now) return "expired";
  return "active";
}

/** The invite form's optional email: empty is none; otherwise lower-cased, or an error. */
export function inviteEmail(text: string): string | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  const email = normalizeEmail(t);
  if (email === null) throw new Error("That is not an email address.");
  return email;
}
