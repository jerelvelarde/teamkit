import { BoardError } from "@copilotkit/teamkit-protocol";
import type { Hono } from "hono";
import type { AppDeps } from "./app.js";
import type { AppEnv } from "./auth.js";
import { pathParam, readBody, reqString } from "./body.js";
import { listMySlackLinks, previewSlackLinkCode, redeemSlackLinkCode, unlinkMySlackUser } from "../slack/links.js";

/**
 * Slack account linking. Every route is for a person signed in on the web board; the link
 * functions refuse tokens with 403.
 */
export function registerSlackRoutes(v1: Hono<AppEnv>, deps: AppDeps): void {
  const { db } = deps;

  // A cookie authenticates these routes, so a cross-site form post could link the victim's
  // account to an attacker's Slack user. Only a fetch that passed CORS can send JSON.
  const requireJson = (auth: { via: string }, contentType: string | undefined) => {
    const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
    if (auth.via === "session" && type !== "application/json") {
      throw new BoardError("invalid_input", "linking must send content-type: application/json");
    }
  };

  // Which Slack user a code is for, so the page can ask "link Slack @handle (U...) to you?".
  v1.post("/slack/link/preview", async (c) => {
    const auth = c.get("auth");
    requireJson(auth, c.req.header("content-type"));
    const body = await readBody(c);
    return c.json(await previewSlackLinkCode(db, auth, reqString(body, "code")));
  });

  // Redeems a code. slackUserId is the Slack user the person confirmed on the page.
  v1.post("/slack/link", async (c) => {
    const auth = c.get("auth");
    requireJson(auth, c.req.header("content-type"));
    const body = await readBody(c);
    return c.json(await redeemSlackLinkCode(db, auth, reqString(body, "code"), reqString(body, "slackUserId")));
  });

  v1.get("/slack/links", async (c) => c.json({ links: await listMySlackLinks(db, c.get("auth")) }));

  v1.post("/slack/links/:slackUserId/unlink", async (c) => {
    const auth = c.get("auth");
    requireJson(auth, c.req.header("content-type"));
    await unlinkMySlackUser(db, auth, pathParam(c, "slackUserId"));
    return c.json({ ok: true });
  });
}
