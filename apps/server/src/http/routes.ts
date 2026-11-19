import type { Hono } from "hono";
import type { AppDeps } from "./app.js";
import type { AppEnv } from "./auth.js";

export function registerRoutes(v1: Hono<AppEnv>, _deps: AppDeps): void {
  v1.get("/whoami", (c) => {
    const { actor, scope, role } = c.get("auth");
    return c.json({ actor, scope, role });
  });
}
