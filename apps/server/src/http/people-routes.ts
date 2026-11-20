import { BoardError, DEVICE_MODES, normalizeEmail, type DeviceMode, type DeviceStart } from "@copilotkit/teamkit-protocol";
import type { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import type { AppDeps } from "./app.js";
import { credentialsOf, sessionCookieName, setSessionCookie, type AppEnv } from "./auth.js";
import { optString, optStringArray, readBody, reqString, requireJsonMediaType } from "./body.js";
import { clientAddress, rateLimited, tokenBucket, type RateLimit } from "./rate-limit.js";
import { DEVICE_POLL_INTERVAL_MS, approveDevice, pollDevice, startDevice } from "../store/device.js";
import { signInEmail } from "../mail.js";
import {
  DEFAULT_PUBLIC_URL,
  consumeSignInLink,
  emailSignInLink,
  signInUrl,
  revokeAdminToken,
  revokeSession,
} from "../store/people.js";

const DEFAULT_DEVICE_START_LIMIT: RateLimit = { burst: 10, perMinute: 10 };
const DEFAULT_EMAIL_SIGNIN_LIMIT: RateLimit = { burst: 5, perMinute: 5 };

export function registerPeopleRoutes(
  v1: Hono<AppEnv>,
  deps: AppDeps,
  opts: { deviceStartLimit?: RateLimit; emailSignInLimit?: RateLimit; trustedProxy?: boolean } = {},
): void {
  const { db } = deps;
  const publicUrl = deps.publicUrl ?? DEFAULT_PUBLIC_URL;
  const secure = publicUrl.startsWith("https://");
  const cookieName = sessionCookieName(publicUrl);
  const deviceStarts = tokenBucket(opts.deviceStartLimit ?? DEFAULT_DEVICE_START_LIMIT);
  const signInEmails = tokenBucket(opts.emailSignInLimit ?? DEFAULT_EMAIL_SIGNIN_LIMIT);

  v1.post("/signin", async (c) => {
    // A public route sets a cookie, so a cross-site form post could sign a victim in as the
    // attacker (login CSRF). Only a fetch that passed CORS can send application/json.
    requireJsonMediaType(c, "sign-in must send content-type: application/json");
    const body = await readBody(c);
    const s = await consumeSignInLink(db, reqString(body, "token"));
    setSessionCookie(c, publicUrl, s.sessionSecret);
    return c.json({ actor: s.actor, role: s.role });
  });

  v1.post("/signin/email", async (c) => {
    requireJsonMediaType(c, "email sign-in must send content-type: application/json");
    const mailer = deps.mailer;
    if (!mailer) throw new BoardError("invalid_state", "this server cannot send email; ask an admin for a sign-in link");
    const waitMs = signInEmails.take(clientAddress(c, opts.trustedProxy === true));
    if (waitMs > 0) return rateLimited(c, waitMs, "too many sign-in emails requested; try again shortly");
    const email = normalizeEmail(reqString(await readBody(c), "email"));
    if (email === null) throw new BoardError("invalid_input", "that is not an email address");
    const found = await emailSignInLink(db, email);
    if (found) {
      // Sent in the background: the answer and its timing are the same whether or not anyone has this email.
      const msg = signInEmail({ to: email, person: found.person.name, link: signInUrl(publicUrl, found.secret) });
      mailer.send(msg).catch((e: unknown) => {
        console.warn(`email sign-in: sending failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    return c.json({ ok: true }, 202);
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
    const body = await readBody(c);
    const raw = optString(body, "mode") ?? "admin";
    if (!(DEVICE_MODES as readonly string[]).includes(raw)) throw new BoardError("invalid_input", "mode must be admin or agent");
    const d = await startDevice(db, raw as DeviceMode, optString(body, "app"));
    // The app in the link only changes what the approve page says; the code itself carries the app.
    const query = d.mode === "agent" ? `&mode=agent${d.app ? `&app=${d.app}` : ""}` : "";
    const out: DeviceStart = {
      deviceCode: d.deviceCode,
      userCode: d.userCode,
      verifyUrl: `${publicUrl}/device?code=${d.userCode}${query}`,
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
