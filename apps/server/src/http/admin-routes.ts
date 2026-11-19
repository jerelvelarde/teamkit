import { BoardError, type CreatedToken, type GrantSpec, type Invite, type Role } from "@copilotkit/teamkit-protocol";
import type { Hono } from "hono";
import type { AppDeps } from "./app.js";
import { requireAdmin, type AppEnv } from "./auth.js";
import { optString, pathParam, readBody, reqString } from "./body.js";
import { createAgent, createAgentTokens, listTokens, revokeToken, type AuthContext, type Grant } from "../store/actors.js";
import { createSignInLink, DEFAULT_PUBLIC_URL, invitePerson, listPeople, signInUrl } from "../store/people.js";
import { listRoomInfos, setRoom, type RoomSettings } from "../store/rooms.js";

const ROOM_SETTING_KEYS = ["agent", "approvers", "slackChannel", "slackAnnounce"] as const;

/**
 * A sign-in link becomes a person session, and a session can answer approvals. An
 * admin-scope token (which a coding agent in the same shell could read) must never mint one.
 */
function requireAdminSession(auth: AuthContext): void {
  requireAdmin(auth);
  if (auth.via !== "session") {
    throw new BoardError("forbidden", "inviting people needs an admin signed in on the web board");
  }
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
}
