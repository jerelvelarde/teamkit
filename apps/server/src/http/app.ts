import { ERROR_STATUS, MAX_BODY_BYTES, isBoardError } from "@copilotkit/teamkit-protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Db } from "../db/pool.js";
import type { Notifier } from "../notifier.js";
import { bearerAuth, type AppEnv } from "./auth.js";
import { registerClaimNext } from "./claim-next.js";
import { registerRoutes } from "./routes.js";
import { registerStream } from "./stream.js";
import { registerTaskRoutes } from "./task-routes.js";

export interface AppDeps {
  db: Db;
  notifier: Notifier;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json({ error: { code: "too_large", message: "request body too large" } }, ERROR_STATUS.too_large),
    }),
    bearerAuth(deps.db),
  );

  const v1 = new Hono<AppEnv>();
  registerRoutes(v1, deps);
  registerClaimNext(v1, deps);
  registerTaskRoutes(v1, deps);
  registerStream(v1, deps);
  app.route("/v1", v1);

  app.onError((e, c) => {
    if (isBoardError(e)) {
      return c.json({ error: { code: e.code, message: e.message } }, ERROR_STATUS[e.code]);
    }
    console.error("unhandled error", e);
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: "no such route" } }, 404));

  return app;
}
