import { ERROR_STATUS, MAX_BODY_BYTES, isBoardError } from "@copilotkit/teamkit-protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Db } from "../db/pool.js";
import type { Notifier } from "../notifier.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { requestAuth, type AppEnv } from "./auth.js";
import { registerClaimNext } from "./claim-next.js";
import { registerPeopleRoutes } from "./people-routes.js";
import { registerRoutes } from "./routes.js";
import { registerStream } from "./stream.js";
import { registerTaskRoutes } from "./task-routes.js";

export interface AppDeps {
  db: Db;
  notifier: Notifier;
  /** The web board's public origin, used for links shown to people and the cookie's Secure flag (default DEFAULT_PUBLIC_URL). */
  publicUrl?: string;
}

export interface AppOptions {
  /** How often an SSE stream pings and re-checks its token or session (default 15 s). */
  streamPingMs?: number;
  /** Longest an SSE stream stays open before the client must reconnect with Last-Event-ID (default 30 min). */
  streamMaxMs?: number;
}

/** SQLSTATE class 22, data exception: Postgres refused a value it was sent (NUL, bad encoding, out of range). */
function isDataException(e: unknown): e is Error & { code: string } {
  if (!(e instanceof Error) || e.name !== "PostgresError") return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("22");
}

export function createApp(deps: AppDeps, opts: AppOptions = {}): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json({ error: { code: "too_large", message: "request body too large" } }, ERROR_STATUS.too_large),
    }),
    requestAuth(deps.db),
  );

  const v1 = new Hono<AppEnv>();
  registerRoutes(v1, deps);
  registerClaimNext(v1, deps);
  registerTaskRoutes(v1, deps);
  registerStream(v1, deps, { pingMs: opts.streamPingMs, maxMs: opts.streamMaxMs });
  registerPeopleRoutes(v1, deps);
  registerAdminRoutes(v1, deps);
  app.route("/v1", v1);

  app.onError((e, c) => {
    if (isBoardError(e)) {
      return c.json({ error: { code: e.code, message: e.message } }, ERROR_STATUS[e.code]);
    }
    if (isDataException(e)) {
      // Backstop for input no validator caught. The client gets no SQL details.
      console.warn(`database rejected request input: SQLSTATE ${e.code}`);
      return c.json({ error: { code: "invalid_input", message: "invalid input" } }, ERROR_STATUS.invalid_input);
    }
    console.error("unhandled error", e);
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: "no such route" } }, 404));

  return app;
}
