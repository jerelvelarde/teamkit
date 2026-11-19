import { BoardError } from "@copilotkit/teamkit-protocol";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Db } from "../db/pool.js";
import { authenticate, type AuthContext } from "../store/actors.js";
import { authenticateSession } from "../store/people.js";

export type AppEnv = { Variables: { auth: AuthContext } };

/** The web board's session cookie, set at sign-in, when the board is served over plain http. */
export const SESSION_COOKIE = "teamkit_session";

/**
 * The session cookie when the board is served over https. A browser only accepts a
 * `__Host-` cookie that is Secure, has Path=/ and no Domain, so no sibling subdomain can
 * plant or overwrite it.
 */
export const SECURE_SESSION_COOKIE = "__Host-teamkit_session";

/** The session cookie's name for a board served at `publicUrl`. */
export function sessionCookieName(publicUrl: string | undefined): string {
  return publicUrl?.startsWith("https://") ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

/** Routes reachable with no credentials at all. */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/v1/signin", "/v1/device/start", "/v1/device/poll"]);

/** Methods a browser may send cross-site without changing state; every other method is state-changing. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

const BEARER_RE = /^Bearer +(\S+)$/i;

/** The token in an `Authorization: Bearer <token>` header, if there is one. */
export function bearerToken(header: string | undefined): string | undefined {
  return BEARER_RE.exec(header ?? "")?.[1];
}

export interface Credentials {
  bearer?: string;
  session?: string;
}

/** The credentials a request carries. A bearer token wins over the session cookie named `cookieName`. */
export function credentialsOf(c: Context, cookieName: string): Credentials {
  const bearer = bearerToken(c.req.header("authorization"));
  if (bearer !== undefined) return { bearer };
  const session = getCookie(c, cookieName);
  return session ? { session } : {};
}

/** Whether the credentials still authenticate: a bearer through its token row, else a session through its session row. */
export async function credentialsValid(db: Db, cr: Credentials): Promise<boolean> {
  if (cr.bearer !== undefined) return (await authenticate(db, cr.bearer)) !== null;
  if (cr.session !== undefined) return (await authenticateSession(db, cr.session)) !== null;
  return false;
}

function isAdminPath(path: string): boolean {
  return path === "/v1/whoami" || path === "/v1/logout" || path.startsWith("/v1/admin/");
}

/**
 * Sets `auth` from a bearer token or, failing that, the session cookie.
 *
 * A cookie rides along on any request the browser sends, including a cross-site
 * form post, so a cookie-authenticated request that can change state must be JSON:
 * a cross-site form cannot send `application/json` without a CORS preflight, which
 * this server never grants. Admin-scope tokens (the command-line sign-in) work only
 * on admin routes, so nothing a person can do from a shell posts, claims or answers
 * on the board in their name.
 */
export function requestAuth(db: Db, cookieName: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = c.req.path;
    if (PUBLIC_PATHS.has(path)) return next();

    const cr = credentialsOf(c, cookieName);
    let auth: AuthContext;
    if (cr.bearer !== undefined) {
      const found = await authenticate(db, cr.bearer);
      if (!found) throw new BoardError("unauthorized", "invalid token");
      auth = { actor: found.actor, via: "token", scope: found.scope, role: found.role };
    } else if (cr.session !== undefined) {
      const found = await authenticateSession(db, cr.session);
      if (!found) throw new BoardError("unauthorized", "session expired or invalid");
      auth = { actor: found.actor, via: "session", scope: null, role: found.role };
      const type = (c.req.header("content-type") ?? "").toLowerCase();
      if (!SAFE_METHODS.has(c.req.method) && !type.startsWith("application/json")) {
        throw new BoardError(
          "invalid_input",
          "cookie-authenticated requests must send content-type: application/json",
        );
      }
    } else {
      throw new BoardError("unauthorized", "missing bearer token");
    }

    if (auth.scope === "admin" && !isAdminPath(path)) {
      throw new BoardError("forbidden", "admin tokens only work for admin commands");
    }
    c.set("auth", auth);
    await next();
  };
}

/** Admin routes: a person with the admin role, signed in on the web board or through an admin-scope token. */
export function requireAdmin(auth: AuthContext): void {
  const ok =
    auth.actor.kind === "person" &&
    auth.role === "admin" &&
    (auth.via === "session" || auth.scope === "admin");
  if (!ok) throw new BoardError("forbidden", "admins only");
}
