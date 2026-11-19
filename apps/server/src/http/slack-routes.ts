import { BoardError } from "@copilotkit/teamkit-protocol";
import type { Hono } from "hono";
import type { AppDeps } from "./app.js";
import type { AppEnv } from "./auth.js";
import { pathParam, readBody, reqString } from "./body.js";
import { listMySlackLinks, previewSlackLinkCode, redeemSlackLinkCode, unlinkMySlackUser } from "../slack/links.js";
import { handleSlackCommand, verifySlackSignature } from "../slack/commands.js";

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

  // Slack's slash-command POST for /teamkit. Public: Slack signs it with the app's signing secret,
  // checked against the raw body before anything is read from it. Off without the secret.
  v1.post("/slack/commands", async (c) => {
    const secret = deps.slackSigningSecret;
    if (!secret) throw new BoardError("not_found", "slash commands are off: SLACK_SIGNING_SECRET is not set");
    const raw = await c.req.text();
    const signed = verifySlackSignature(
      secret,
      { signature: c.req.header("x-slack-signature"), timestamp: c.req.header("x-slack-request-timestamp") },
      raw,
      Date.now(),
    );
    if (!signed) throw new BoardError("unauthorized", "invalid Slack signature");
    const form = new URLSearchParams(raw);
    const text = await handleSlackCommand(
      { db, publicUrl: deps.publicUrl ?? "" },
      {
        userId: form.get("user_id") ?? "",
        userName: form.get("user_name") || null,
        channelId: form.get("channel_id") ?? "",
        text: form.get("text") ?? "",
      },
    );
    return c.json({ response_type: "ephemeral", text });
  });

  v1.post("/slack/links/:slackUserId/unlink", async (c) => {
    const auth = c.get("auth");
    requireJson(auth, c.req.header("content-type"));
    await unlinkMySlackUser(db, auth, pathParam(c, "slackUserId"));
    return c.json({ ok: true });
  });
}
