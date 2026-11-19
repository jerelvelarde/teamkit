import {
  BoardError,
  EVENT_KINDS,
  isValidRoomPattern,
  newId,
  newTokenSecret,
  type CreatedTrigger,
  type EventKind,
  type TriggerAction,
  type TriggerInfo,
  type TriggerInput,
} from "@copilotkit/teamkit-protocol";
import type { Db, Q } from "../db/pool.js";
import { getAgent } from "../dispatch/registry.js";
import { currentCursor } from "../store/events.js";
import { validateLabels } from "../store/rows.js";

export interface StoredTrigger extends TriggerInfo {
  secret: string | null;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KIND_SET: ReadonlySet<string> = new Set(EVENT_KINDS);

function toTrigger(r: Record<string, unknown>): StoredTrigger {
  return {
    id: r.id as string,
    name: r.name as string,
    room: r.room_filter as string,
    kinds: r.kinds as EventKind[],
    labels: (r.labels as Record<string, string> | null) ?? null,
    action: r.action as TriggerAction,
    secret: (r.secret as string | null) ?? null,
    cursor: String(r.cursor),
    enabled: r.enabled as boolean,
    createdAt: (r.created_at as Date).toISOString(),
  };
}

/** Strips the secret: it leaves the server only in `addTrigger`'s result. */
function toInfo({ secret: _secret, ...info }: StoredTrigger): TriggerInfo {
  return info;
}

function validate(input: TriggerInput): { labels: Record<string, string> | null; action: TriggerAction } {
  const { name, room, kinds, webhook, agent } = input;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new BoardError("invalid_input", `invalid trigger name: ${String(name)}`);
  }
  if (typeof room !== "string" || !isValidRoomPattern(room)) {
    throw new BoardError("invalid_input", `invalid room pattern: ${String(room)}`);
  }
  if (!Array.isArray(kinds) || kinds.length === 0) {
    throw new BoardError("invalid_input", "kinds must be a non-empty array");
  }
  for (const k of kinds) {
    if (typeof k !== "string" || !KIND_SET.has(k)) {
      throw new BoardError("invalid_input", `invalid event kind: ${String(k)}`);
    }
  }
  const labels = input.labels === undefined ? null : validateLabels(input.labels);
  if ((webhook === undefined) === (agent === undefined)) {
    throw new BoardError("invalid_input", "give exactly one of webhook or agent");
  }
  if (webhook !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(webhook);
    } catch {
      throw new BoardError("invalid_input", "invalid webhook url");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BoardError("invalid_input", "webhook url must be http or https");
    }
    return { labels, action: { type: "webhook", url: webhook } };
  }
  if (typeof agent !== "string") throw new BoardError("invalid_input", "agent must be a string");
  return { labels, action: { type: "agent", agent } };
}

export async function addTrigger(
  db: Db,
  input: TriggerInput & { createdBy?: string },
): Promise<CreatedTrigger> {
  const { labels, action } = validate(input);
  const kinds = [...new Set(input.kinds)];
  const id = newId("tr");
  // "tk_" + 43 base64url characters, re-prefixed.
  const secret = action.type === "webhook" ? "whsec_" + newTokenSecret().slice(3) : null;
  const createdBy = input.createdBy ?? null;
  return db.begin(async (tx) => {
    if (action.type === "agent" && !(await getAgent(tx, action.agent))) {
      throw new BoardError("invalid_input", `unknown agent: ${action.agent}`);
    }
    const [dup] = await tx`select 1 as x from triggers where name = ${input.name}`;
    if (dup) throw new BoardError("invalid_input", `trigger ${input.name} already exists`);
    const cursor = await currentCursor(tx);
    let row;
    try {
      [row] = await tx`
        insert into triggers (id, name, room_filter, kinds, labels, action, secret, cursor, created_by)
        values (${id}, ${input.name}, ${input.room}, ${kinds},
                ${labels === null ? null : tx.json(labels)}, ${tx.json(action)}, ${secret}, ${cursor}::bigint, ${createdBy})
        returning *`;
    } catch (e) {
      if ((e as { code?: unknown }).code === "23505") {
        throw new BoardError("invalid_input", `trigger ${input.name} already exists`);
      }
      throw e;
    }
    const stored = toTrigger(row!);
    return { trigger: toInfo(stored), secret };
  });
}

export async function listTriggers(db: Db): Promise<TriggerInfo[]> {
  const rows = await db`select * from triggers order by name`;
  return rows.map((r) => toInfo(toTrigger(r)));
}

/** Enabled triggers with their secrets, for the runner only. */
export async function listStoredTriggers(db: Db): Promise<StoredTrigger[]> {
  const rows = await db`select * from triggers where enabled order by name`;
  return rows.map(toTrigger);
}

export async function removeTrigger(db: Db, name: string): Promise<void> {
  const rows = await db`delete from triggers where name = ${name} returning id`;
  if (rows.length === 0) throw new BoardError("not_found", `trigger not found: ${name}`);
}

export async function setTriggerEnabled(db: Db, name: string, enabled: boolean): Promise<void> {
  const rows = await db`update triggers set enabled = ${enabled} where name = ${name} returning id`;
  if (rows.length === 0) throw new BoardError("not_found", `trigger not found: ${name}`);
}

export async function advanceTrigger(q: Q, id: string, cursor: string): Promise<void> {
  await q`update triggers set cursor = greatest(cursor, ${cursor}::bigint) where id = ${id}`;
}
