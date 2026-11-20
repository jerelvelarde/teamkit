import { BoardError, type CreatedJoinLink, type Whoami } from "@copilotkit/teamkit-protocol";
import type { Hono } from "hono";
import type { AppDeps } from "./app.js";
import { requireAdmin, requireAdminSession, setSessionCookie, type AppEnv } from "./auth.js";
import { optStringArray, pathParam, readBody, reqString, requireJsonMediaType } from "./body.js";
import { clientAddress, rateLimited, tokenBucket, type RateLimit } from "./rate-limit.js";
import { createJoinLink, joinUrl, listJoinLinks, redeemJoinLink, revokeJoinLink } from "../store/join.js";
import { DEFAULT_PUBLIC_URL } from "../store/people.js";

const DEFAULT_JOIN_LIMIT: RateLimit = { burst: 30, perMinute: 30 };

export function registerJoinRoutes(
  v1: Hono<AppEnv>,
  deps: AppDeps,
  opts: { joinLimit?: RateLimit; trustedProxy?: boolean } = {},
): void {
  const { db } = deps;
  const publicUrl = deps.publicUrl ?? DEFAULT_PUBLIC_URL;
  const joins = tokenBucket(opts.joinLimit ?? DEFAULT_JOIN_LIMIT);

  v1.post("/admin/join-links", async (c) => {
    const auth = c.get("auth");
    requireAdminSession(auth, "creating join links needs an admin signed in on the web board");
    const body = await readBody(c);
    const days = body.expiresInDays;
    if (days !== undefined && typeof days !== "number") {
      throw new BoardError("invalid_input", "expiresInDays must be a number");
    }
    const { joinLink, secret } = await createJoinLink(db, {
      createdBy: auth.actor.id,
      expiresInDays: days,
      domains: optStringArray(body, "domains"),
    });
    const out: CreatedJoinLink = { ...joinLink, link: joinUrl(publicUrl, secret) };
    return c.json(out, 201);
  });

  v1.get("/admin/join-links", async (c) => {
    requireAdmin(c.get("auth"));
    return c.json(await listJoinLinks(db));
  });

  v1.post("/admin/join-links/:id/revoke", async (c) => {
    requireAdmin(c.get("auth"));
    await revokeJoinLink(db, pathParam(c, "id"));
    return c.json({ ok: true });
  });

  v1.post("/join", async (c) => {
    // Public and it sets a cookie: application/json only (login CSRF), and a budget per address.
    requireJsonMediaType(c, "joining must send content-type: application/json");
    const waitMs = joins.take(clientAddress(c, opts.trustedProxy === true));
    if (waitMs > 0) return rateLimited(c, waitMs, "too many join attempts; try again shortly");
    const body = await readBody(c);
    const s = await redeemJoinLink(db, {
      code: reqString(body, "code"),
      name: reqString(body, "name"),
      email: reqString(body, "email"),
    });
    setSessionCookie(c, publicUrl, s.sessionSecret);
    const who: Whoami = { actor: s.actor, scope: null, role: s.role };
    return c.json(who, 201);
  });
}
