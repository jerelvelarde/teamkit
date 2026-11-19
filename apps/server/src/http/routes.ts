import { BoardError } from "@copilotkit/teamkit-protocol";
import type { Hono } from "hono";
import type { AppDeps } from "./app.js";
import type { AppEnv } from "./auth.js";
import { eventQueryFromRequest, readBody, reqString } from "./body.js";
import { readEvents } from "../store/feed.js";
import { getRoom, listRooms } from "../store/rooms.js";
import { getThread, post, reply, setLabel } from "../store/threads.js";

export function registerRoutes(v1: Hono<AppEnv>, deps: AppDeps): void {
  const { db } = deps;

  v1.get("/whoami", (c) => {
    const { actor, scope, role } = c.get("auth");
    return c.json({ actor, scope, role });
  });

  v1.get("/rooms", async (c) => c.json({ rooms: await listRooms(db, c.get("auth")) }));

  v1.get("/room", async (c) => {
    const name = c.req.query("name");
    if (name === undefined || name === "") throw new BoardError("invalid_input", "name is required");
    const after = c.req.query("after");
    return c.json(await getRoom(db, c.get("auth"), name, after === undefined ? undefined : { after }));
  });

  v1.get("/threads/:id", async (c) => c.json(await getThread(db, c.get("auth"), c.req.param("id"))));

  v1.post("/posts", async (c) => {
    const b = await readBody(c);
    const out = await post(db, c.get("auth"), { room: reqString(b, "room"), text: reqString(b, "text") });
    return c.json(out, 201);
  });

  v1.post("/threads/:id/replies", async (c) => {
    const b = await readBody(c);
    await reply(db, c.get("auth"), c.req.param("id"), reqString(b, "text"));
    return c.json({ ok: true }, 201);
  });

  v1.post("/threads/:id/labels", async (c) => {
    const b = await readBody(c);
    await setLabel(db, c.get("auth"), c.req.param("id"), reqString(b, "key"), reqString(b, "value"));
    return c.json({ ok: true }, 200);
  });

  v1.get("/events", async (c) => c.json(await readEvents(db, c.get("auth"), eventQueryFromRequest(c))));
}
