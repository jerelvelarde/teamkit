import { BoardError } from "@copilotkit/teamkit-protocol";
import type { MiddlewareHandler } from "hono";
import type { Db } from "../db/pool.js";
import { authenticate, type AuthContext } from "../store/actors.js";

export type AppEnv = { Variables: { auth: AuthContext } };

const BEARER_RE = /^Bearer +(\S+)$/i;

export function bearerAuth(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const m = BEARER_RE.exec(c.req.header("authorization") ?? "");
    if (!m) throw new BoardError("unauthorized", "missing bearer token");
    const found = await authenticate(db, m[1]!);
    if (!found) throw new BoardError("unauthorized", "invalid token");
    c.set("auth", { actor: found.actor, via: "token", scope: found.scope, role: found.role });
    await next();
  };
}
