import { Hono } from "hono";

/** Names of the agents mounted on this server; later tasks push into it. */
export const agents: string[] = [];

export function createExampleApp(_env: NodeJS.ProcessEnv = process.env): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true, agents }));
  return app;
}
