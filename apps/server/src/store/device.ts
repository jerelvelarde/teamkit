import { BoardError, newId, newTokenSecret, type DevicePoll } from "@copilotkit/teamkit-protocol";
import { hashToken } from "@copilotkit/teamkit-protocol/server";
import type { Db } from "../db/pool.js";
import type { AuthContext } from "./actors.js";

export const DEVICE_POLL_INTERVAL_MS = 2000;
const DEVICE_TTL_MS_DEFAULT = 600_000;
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_ATTEMPTS = 5;
/** Expired codes are deleted this long after they expire, so a CLI polling at the deadline still reads "expired". */
const DEVICE_PRUNE_AFTER_MS = 3_600_000;

/** Device-code lifetime in ms. Read at call time so tests can change TEAMKIT_DEVICE_TTL_MS. */
export function deviceTtlMs(): number {
  const raw = process.env.TEAMKIT_DEVICE_TTL_MS;
  if (raw === undefined || raw === "") return DEVICE_TTL_MS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEVICE_TTL_MS_DEFAULT;
}

/** "bcdf ghjk" -> "BCDF-GHJK"; null when it is not 8 characters of the code alphabet. */
export function normalizeUserCode(input: string): string | null {
  if (typeof input !== "string") return null;
  const s = input.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (s.length !== 8) return null;
  for (const c of s) if (!USER_CODE_ALPHABET.includes(c)) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function randomUserCode(): string {
  const n = USER_CODE_ALPHABET.length;
  const limit = 256 - (256 % n); // reject the top bytes so every letter is equally likely
  let s = "";
  while (s.length < 8) {
    for (const b of globalThis.crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && s.length < 8) s += USER_CODE_ALPHABET[b % n];
    }
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function randomDeviceCode(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes));
  return "dc_" + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

export async function startDevice(
  db: Db,
): Promise<{ deviceCode: string; userCode: string; expiresAt: string }> {
  const ms = deviceTtlMs();
  const deviceCode = randomDeviceCode();
  // device/start is public, so every start also clears out codes long past their expiry.
  await db`
    delete from device_codes
    where expires_at < now() - (${DEVICE_PRUNE_AFTER_MS}::double precision / 1000) * interval '1 second'`;
  for (let attempt = 1; ; attempt++) {
    const userCode = randomUserCode();
    try {
      const [row] = await db`
        insert into device_codes (code, user_code, expires_at)
        values (${hashToken(deviceCode)}, ${userCode}, now() + (${ms}::double precision / 1000) * interval '1 second')
        returning expires_at`;
      return { deviceCode, userCode, expiresAt: new Date(row!.expires_at as Date).toISOString() };
    } catch (e) {
      if (!isUniqueViolation(e) || attempt >= USER_CODE_ATTEMPTS) throw e;
    }
  }
}

export async function approveDevice(db: Db, auth: AuthContext, userCode: string): Promise<void> {
  if (auth.via !== "session" || auth.actor.kind !== "person") {
    throw new BoardError("forbidden", "approving a command-line login needs a signed-in person");
  }
  const normalized = normalizeUserCode(userCode);
  if (!normalized) throw new BoardError("invalid_input", "that is not a valid login code");
  await db.begin(async (tx) => {
    const [row] = await tx`
      select approved_at from device_codes
      where user_code = ${normalized} and expires_at > now() and consumed_at is null
      for update`;
    if (!row) throw new BoardError("not_found", "unknown or expired code");
    if (row.approved_at) throw new BoardError("invalid_state", "this code was already approved");
    await tx`
      update device_codes set actor_id = ${auth.actor.id}, approved_at = now()
      where user_code = ${normalized}`;
  });
}

export async function pollDevice(db: Db, deviceCode: string): Promise<DevicePoll> {
  const hash = typeof deviceCode === "string" ? hashToken(deviceCode) : "";
  return db.begin(async (tx): Promise<DevicePoll> => {
    const [row] = await tx`
      select d.actor_id, d.approved_at, d.consumed_at, d.expires_at <= now() as expired,
             a.name, a.kind
      from device_codes d left join actors a on a.id = d.actor_id
      where d.code = ${hash}
      for update of d`;
    if (!row) throw new BoardError("not_found", "unknown device code");
    // An approved code is collectable once, and only until it expires.
    if (row.consumed_at || row.expired) return { status: "expired" };
    if (!row.approved_at) return { status: "pending" };
    const token = newTokenSecret();
    const tokenId = newId("tok");
    await tx`insert into tokens (id, actor_id, hash, scope)
             values (${tokenId}, ${row.actor_id}, ${hashToken(token)}, 'admin')`;
    await tx`update device_codes set consumed_at = now(), token_id = ${tokenId} where code = ${hash}`;
    return {
      status: "approved",
      token,
      actor: { id: row.actor_id as string, name: row.name as string, kind: row.kind as "agent" | "person" },
    };
  });
}
