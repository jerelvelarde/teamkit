import type { Permission } from "@copilotkit/teamkit-protocol";
import type { Db } from "../../src/db/pool.js";
import { createAgent, createPerson, type AuthContext } from "../../src/store/actors.js";

export async function agentAuth(
  db: Db,
  name: string,
  grants: { room: string; perms: Permission[] }[] = [
    { room: "*", perms: ["read", "post", "claim", "create"] },
  ],
): Promise<AuthContext & { token: string }> {
  const { actor, token } = await createAgent(db, { name, grants });
  return { actor, via: "token", scope: "agent", role: null, token };
}

export async function personAuth(
  db: Db,
  name: string,
  role: "admin" | "member" = "member",
): Promise<AuthContext> {
  const actor = await createPerson(db, { name, role });
  return { actor, via: "session", scope: null, role };
}
