import { createHash, randomBytes } from "node:crypto";

export const ID_PREFIXES = {
  thread: "th",
  claim: "cl",
  actor: "ac",
  token: "tok",
  interrupt: "in",
  run: "run",
  trigger: "tr",
  message: "msg",
} as const;

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function newTokenSecret(): string {
  return "tk_" + randomBytes(32).toString("base64url");
}

export function hashToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
