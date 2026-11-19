import { BoardError, type AgentInfo, type CreatedToken, type EventKind, type GrantSpec, type Invite, type Role, type TriggerInfo, type TriggerInput } from "@copilotkit/teamkit-protocol";
import type { Hono } from "hono";
import type { AppDeps } from "./app.js";
import { requireAdmin, requireAdminSession as requireBoardAdmin, type AppEnv } from "./auth.js";
import { optLabels, optString, optStringArray, pathParam, readBody, reqString } from "./body.js";
import { getAgent, listAgents, registerAgent, setAgentEnabled, toAgentInfo } from "../dispatch/registry.js";
import { createAgent, createAgentTokens, listTokens, revokeToken, type AuthContext, type Grant } from "../store/actors.js";
import { createSignInLink, DEFAULT_PUBLIC_URL, invitePerson, listPeople, signInUrl } from "../store/people.js";
import { addTrigger, listTriggers, removeTrigger, setTriggerEnabled } from "../triggers/store.js";
import { listRoomInfos, setRoom, type RoomSettings } from "../store/rooms.js";

const ROOM_SETTING_KEYS = ["agent", "approvers", "slackChannel", "slackAnnounce"] as const;

/** A sign-in link becomes a person session, so only an admin on the web board may make one. */
function requireAdminSession(auth: AuthContext): void {
  requireBoardAdmin(auth, "inviting people needs an admin signed in on the web board");
}

function parseGrants(b: Record<string, unknown>): Grant[] {
  const rooms = b.rooms;
  if (!Array.isArray(rooms) || rooms.length === 0) {
    throw new BoardError("invalid_input", "rooms must be a non-empty array of {room, perms}");
  }
  return rooms.map((g: unknown): GrantSpec => {
    const r = g as { room?: unknown; perms?: unknown } | null;
    if (typeof r !== "object" || r === null || typeof r.room !== "string" || !Array.isArray(r.perms) || !r.perms.every((p) => typeof p === "string")) {
      throw new BoardError("invalid_input", "each rooms entry must be {room: string, perms: string[]}");
    }
    return r as GrantSpec;
  });
}

/**
 * Agents are registered by admins only, so private and loopback hosts are allowed. We still
 * refuse non-http(s) schemes and credentials embedded in the URL (they would be stored and
 * returned in clear text by the listing).
 */
function parseAgentUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BoardError("invalid_input", "agent url is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new BoardError("invalid_input", "agent url must be http or https");
  }
  if (u.username !== "" || u.password !== "") {
    throw new BoardError("invalid_input", "agent url must not contain credentials; use headers");
  }
  return url;
}

/** Webhook URLs are stored and listed, so they must be http(s) with no embedded credentials. */
function parseWebhookUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BoardError("invalid_input", "webhook url is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new BoardError("invalid_input", "webhook url must be http or https");
  }
  if (u.username !== "" || u.password !== "") {
    throw new BoardError("invalid_input", "webhook url must not contain credentials");
  }
  return url;
}

export function registerAdminRoutes(v1: Hono<AppEnv>, deps: AppDeps): void {
  const { db } = deps;
  const publicUrl = deps.publicUrl ?? DEFAULT_PUBLIC_URL;

  v1.get("/admin/people", async (c) => {
    requireAdmin(c.get("auth"));
    return c.json(await listPeople(db));
  });

  v1.post("/admin/people", async (c) => {
    requireAdminSession(c.get("auth"));
    const b = await readBody(c);
    const name = reqString(b, "name");
    const role = optString(b, "role") ?? "member";
    if (role !== "admin" && role !== "member") throw new BoardError("invalid_input", "role must be admin or member");
    const inv = await invitePerson(db, { name, role: role as Role });
    const invite: Invite = { person: inv.person, role: inv.role, link: signInUrl(publicUrl, inv.secret) };
    return c.json(invite, 201);
  });

  v1.post("/admin/people/:name/link", async (c) => {
    requireAdminSession(c.get("auth"));
    const name = pathParam(c, "name");
    const [p] = await db`select id from actors where name = ${name} and kind = 'person'`;
    if (!p) throw new BoardError("not_found", `person not found: ${name}`);
    const secret = await createSignInLink(db, p.id as string);
    return c.json({ link: signInUrl(publicUrl, secret) });
  });

  v1.get("/admin/tokens", async (c) => {
    requireAdmin(c.get("auth"));
    return c.json(await listTokens(db));
  });

  v1.post("/admin/tokens", async (c) => {
    const auth = c.get("auth");
    requireAdmin(auth);
    const b = await readBody(c);
    const name = reqString(b, "name");
    const grants = parseGrants(b);
    let tokens: CreatedToken[];
    if (b.count !== undefined) {
      if (typeof b.count !== "number") throw new BoardError("invalid_input", "count must be a number");
      tokens = await createAgentTokens(db, { baseName: name, count: b.count, ownerId: auth.actor.id, grants });
    } else {
      tokens = [await createAgent(db, { name, ownerId: auth.actor.id, grants })];
    }
    return c.json({ tokens }, 201);
  });

  v1.post("/admin/tokens/:id/revoke", async (c) => {
    requireAdmin(c.get("auth"));
    await revokeToken(db, pathParam(c, "id"));
    return c.json({ ok: true });
  });

  v1.get("/admin/rooms", async (c) => {
    requireAdmin(c.get("auth"));
    return c.json(await listRoomInfos(db));
  });

  v1.post("/admin/rooms/:name", async (c) => {
    requireAdmin(c.get("auth"));
    const name = pathParam(c, "name");
    const b = await readBody(c);
    const settings: Record<string, unknown> = {};
    for (const k of ROOM_SETTING_KEYS) if (k in b) settings[k] = b[k];
    return c.json(await setRoom(db, name, settings as RoomSettings));
  });

  v1.get("/admin/agents", async (c) => {
    requireAdmin(c.get("auth"));
    return c.json((await listAgents(db)).map(toAgentInfo));
  });

  v1.post("/admin/agents", async (c) => {
    const auth = c.get("auth");
    requireAdmin(auth);
    const b = await readBody(c);
    const name = reqString(b, "name");
    const url = parseAgentUrl(reqString(b, "url"));
    const rooms = optStringArray(b, "rooms");
    if (rooms === undefined) throw new BoardError("invalid_input", "rooms is required and must be an array of strings");
    const headers = optLabels(b, "headers");
    const agent = await registerAgent(db, {
      name,
      url,
      rooms,
      ...(headers !== undefined ? { headers } : {}),
      ownerId: auth.actor.id,
    });
    const info: AgentInfo = toAgentInfo(agent);
    return c.json(info, 201);
  });

  v1.post("/admin/agents/:name/enabled", async (c) => {
    requireAdmin(c.get("auth"));
    const name = pathParam(c, "name");
    const b = await readBody(c);
    if (typeof b.enabled !== "boolean") throw new BoardError("invalid_input", "enabled must be a boolean");
    await setAgentEnabled(db, name, b.enabled);
    const agent = await getAgent(db, name);
    if (!agent) throw new BoardError("not_found", `agent not found: ${name}`);
    return c.json(toAgentInfo(agent));
  });

  v1.get("/admin/triggers", async (c) => {
    requireAdmin(c.get("auth"));
    return c.json(await listTriggers(db));
  });

  v1.post("/admin/triggers", async (c) => {
    const auth = c.get("auth");
    requireAdmin(auth);
    const b = await readBody(c);
    const kinds = optStringArray(b, "kinds");
    if (kinds === undefined) throw new BoardError("invalid_input", "kinds is required and must be an array of strings");
    const webhook = optString(b, "webhook");
    const labels = optLabels(b, "labels");
    const agent = optString(b, "agent");
    const input: TriggerInput & { createdBy: string } = {
      name: reqString(b, "name"),
      room: reqString(b, "room"),
      kinds: kinds as EventKind[],
      ...(labels !== undefined ? { labels } : {}),
      ...(webhook !== undefined ? { webhook: parseWebhookUrl(webhook) } : {}),
      ...(agent !== undefined ? { agent } : {}),
      createdBy: auth.actor.id,
    };
    return c.json(await addTrigger(db, input), 201);
  });

  v1.post("/admin/triggers/:name/remove", async (c) => {
    requireAdmin(c.get("auth"));
    await removeTrigger(db, pathParam(c, "name"));
    return c.json({ ok: true });
  });

  v1.post("/admin/triggers/:name/enabled", async (c) => {
    requireAdmin(c.get("auth"));
    const name = pathParam(c, "name");
    const b = await readBody(c);
    if (typeof b.enabled !== "boolean") throw new BoardError("invalid_input", "enabled must be a boolean");
    await setTriggerEnabled(db, name, b.enabled);
    const info: TriggerInfo | undefined = (await listTriggers(db)).find((t) => t.name === name);
    if (!info) throw new BoardError("not_found", `trigger not found: ${name}`);
    return c.json(info);
  });
}
