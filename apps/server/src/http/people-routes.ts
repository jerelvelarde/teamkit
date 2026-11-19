import { BoardError, type DeviceStart } from "@copilotkit/teamkit-protocol";
import type { Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { AppDeps } from "./app.js";
import { SESSION_COOKIE, credentialsOf, type AppEnv } from "./auth.js";
import { readBody, reqString } from "./body.js";
import { DEVICE_POLL_INTERVAL_MS, approveDevice, pollDevice, startDevice } from "../store/device.js";
import {
  DEFAULT_PUBLIC_URL,
  SESSION_TTL_MS,
  consumeSignInLink,
  revokeAdminToken,
  revokeSession,
} from "../store/people.js";

/** The media type of a request, without parameters, lower-cased ("" when there is no header). */
function mediaType(c: Context): string {
  return (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
}

export function registerPeopleRoutes(v1: Hono<AppEnv>, deps: AppDeps): void {
  const { db } = deps;
  const publicUrl = deps.publicUrl ?? DEFAULT_PUBLIC_URL;
  const secure = publicUrl.startsWith("https://");

  v1.post("/signin", async (c) => {
    // A public route sets a cookie, so a cross-site form post could sign a victim in as the
    // attacker (login CSRF). Only a fetch that passed CORS can send application/json.
    if (mediaType(c) !== "application/json") {
      throw new BoardError("invalid_input", "sign-in must send content-type: application/json");
    }
    const body = await readBody(c);
    const s = await consumeSignInLink(db, reqString(body, "token"));
    setCookie(c, SESSION_COOKIE, s.sessionSecret, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      secure,
    });
    return c.json({ actor: s.actor, role: s.role });
  });

  v1.post("/logout", async (c) => {
    const auth = c.get("auth");
    const cr = credentialsOf(c);
    if (auth.via === "session" && cr.session !== undefined) {
      await revokeSession(db, cr.session);
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ ok: true });
    }
    if (auth.via === "token" && auth.scope === "admin" && cr.bearer !== undefined) {
      await revokeAdminToken(db, cr.bearer);
      return c.json({ ok: true });
    }
    throw new BoardError("forbidden", "agent tokens are revoked with `teamkit tokens revoke`");
  });

  v1.post("/device/start", async (c) => {
    const d = await startDevice(db);
    const out: DeviceStart = {
      deviceCode: d.deviceCode,
      userCode: d.userCode,
      verifyUrl: `${publicUrl}/device?code=${d.userCode}`,
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
    await approveDevice(db, c.get("auth"), reqString(body, "userCode"));
    return c.json({ ok: true });
  });
}
