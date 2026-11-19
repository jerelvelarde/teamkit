import { BoardError, DEVICE_MODES, type DeviceMode, type DeviceStart } from "@copilotkit/teamkit-protocol";
import type { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import type { AppDeps } from "./app.js";
import { credentialsOf, sessionCookieName, setSessionCookie, type AppEnv } from "./auth.js";
import { optString, optStringArray, readBody, reqString, requireJsonMediaType } from "./body.js";
import { clientAddress, rateLimited, tokenBucket, type RateLimit } from "./rate-limit.js";
import { DEVICE_POLL_INTERVAL_MS, approveDevice, pollDevice, startDevice } from "../store/device.js";
import {
  DEFAULT_PUBLIC_URL,
  consumeSignInLink,
  revokeAdminToken,
  revokeSession,
} from "../store/people.js";

const DEFAULT_DEVICE_START_LIMIT: RateLimit = { burst: 10, perMinute: 10 };

export function registerPeopleRoutes(
  v1: Hono<AppEnv>,
  deps: AppDeps,
  opts: { deviceStartLimit?: RateLimit; trustedProxy?: boolean } = {},
): void {
  const { db } = deps;
  const publicUrl = deps.publicUrl ?? DEFAULT_PUBLIC_URL;
  const secure = publicUrl.startsWith("https://");
  const cookieName = sessionCookieName(publicUrl);
  const deviceStarts = tokenBucket(opts.deviceStartLimit ?? DEFAULT_DEVICE_START_LIMIT);

  v1.post("/signin", async (c) => {
    // A public route sets a cookie, so a cross-site form post could sign a victim in as the
    // attacker (login CSRF). Only a fetch that passed CORS can send application/json.
    requireJsonMediaType(c, "sign-in must send content-type: application/json");
    const body = await readBody(c);
    const s = await consumeSignInLink(db, reqString(body, "token"));
    setSessionCookie(c, publicUrl, s.sessionSecret);
    return c.json({ actor: s.actor, role: s.role });
  });

  v1.post("/logout", async (c) => {
    const auth = c.get("auth");
    const cr = credentialsOf(c, cookieName);
    if (auth.via === "session" && cr.session !== undefined) {
      await revokeSession(db, cr.session);
      deleteCookie(c, cookieName, { path: "/", secure });
      return c.json({ ok: true });
    }
    if (auth.via === "token" && auth.scope === "admin" && cr.bearer !== undefined) {
      await revokeAdminToken(db, cr.bearer);
      return c.json({ ok: true });
    }
    throw new BoardError("forbidden", "agent tokens are revoked with `teamkit tokens revoke`");
  });

  v1.post("/device/start", async (c) => {
    // Public and each call writes a row, so each client address gets a modest budget.
    const waitMs = deviceStarts.take(clientAddress(c, opts.trustedProxy === true));
    if (waitMs > 0) return rateLimited(c, waitMs, "too many login codes requested; try again shortly");
    const raw = optString(await readBody(c), "mode") ?? "admin";
    if (!(DEVICE_MODES as readonly string[]).includes(raw)) throw new BoardError("invalid_input", "mode must be admin or agent");
    const d = await startDevice(db, raw as DeviceMode);
    const out: DeviceStart = {
      deviceCode: d.deviceCode,
      userCode: d.userCode,
      verifyUrl: `${publicUrl}/device?code=${d.userCode}${d.mode === "agent" ? "&mode=agent" : ""}`,
      expiresAt: d.expiresAt,
      intervalMs: DEVICE_POLL_INTERVAL_MS,
    };
    return c.json(out);
  });

  v1.post("/device/poll", async (c) => {
    const body = await readBody(c);
    return c.json(await pollDevice(db, reqString(body, "deviceCode")));
  });

  v1.post("/device/approve", async (c) => {
    const body = await readBody(c);
    const { agent } = await approveDevice(db, c.get("auth"), reqString(body, "userCode"), optStringArray(body, "rooms"));
    return c.json(agent ? { ok: true, agent } : { ok: true });
  });
}
