import { BoardError } from "@copilotkit/teamkit-protocol";
import type { MiddlewareHandler } from "hono";
import type { Db } from "../db/pool.js";
import { authenticate, type AuthContext } from "../store/actors.js";

export type AppEnv = { Variables: { auth: AuthContext } };

const BEARER_RE = /^Bearer +(\S+)$/i;

/** The token in an `Authorization: Bearer <token>` header, if there is one. */
export function bearerToken(header: string | undefined): string | undefined {
  return BEARER_RE.exec(header ?? "")?.[1];
}

export function bearerAuth(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearerToken(c.req.header("authorization"));
    if (token === undefined) throw new BoardError("unauthorized", "missing bearer token");
    const found = await authenticate(db, token);
    if (!found) throw new BoardError("unauthorized", "invalid token");
    c.set("auth", { actor: found.actor, via: "token", scope: found.scope, role: found.role });
    await next();
  };
}
