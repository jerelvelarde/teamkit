import { createHash } from "node:crypto";

export function hashToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
