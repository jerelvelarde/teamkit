/**
 * The Slack view's only door into plan 02's coordination store. It calls the store functions by
 * name and selects from no coordination table itself, so the Slack code stays on plan 02's contract.
 */
import {
  BoardError,
  PRESENCE_ON_MS,
  type Alert,
  type BoardEvent,
  type ChangeEntry,
  type Decision,
  type TaskBlock,
} from "@copilotkit/teamkit-protocol";
import type { Db, Q } from "../db/pool.js";
import type { AuthContext } from "../store/actors.js";
import { confirmAlert, loadAlerts, raiseAlert } from "../store/alerts.js";
import { loadChanges } from "../store/changes.js";
import { loadDecisions, postDecision } from "../store/decisions.js";
import { loadPresence } from "../store/presence.js";

/**
 * Who an ask waits on: its named approvers; else, for an approval, the room's approvers; else
 * null (anyone who may answer). An empty list counts as none.
 */
export function waitsOn(block: TaskBlock, roomApprovers: string[] | null): string[] | null {
  if (block.approvers && block.approvers.length > 0) return block.approvers;
  if (block.kind === "awaiting_approval" && roomApprovers && roomApprovers.length > 0) return roomApprovers;
  return null;
}

/** The decision, alert or change a coordination event is about; null for any other kind. */
export function entityIdOf(e: BoardEvent): string | null {
  const data = e.data as Record<string, unknown>;
  const pick = (key: string) => (typeof data[key] === "string" ? (data[key] as string) : null);
  if (e.kind.startsWith("decision.")) return pick("decisionId");
  if (e.kind.startsWith("alert.")) return pick("alertId");
  if (e.kind.startsWith("change.")) return pick("changeId");
  return null;
}

/** The agent a `task.handed_off` event names; null for any other event. */
export function handoffTarget(e: BoardEvent): string | null {
  if (e.kind !== "task.handed_off") return null;
  const to = (e.data as { to?: { name?: unknown } }).to;
  return typeof to?.name === "string" ? to.name : null;
}

export async function loadDecision(q: Q, id: string): Promise<Decision | null> {
  return (await loadDecisions(q, [id]))[0] ?? null;
}

export async function loadAlert(q: Q, id: string): Promise<Alert | null> {
  return (await loadAlerts(q, [id]))[0] ?? null;
}

export async function loadChange(q: Q, id: string): Promise<ChangeEntry | null> {
  return (await loadChanges(q, [id]))[0] ?? null;
}

/** Agents on in a room: sessions seen within PRESENCE_ON_MS of `now`, counted per agent, sorted by name. */
export async function agentsOn(q: Q, room: string, now: number): Promise<{ name: string; sessions: number }[]> {
  const out: { name: string; sessions: number }[] = [];
  for (const p of await loadPresence(q, room)) {
    const sessions = p.sessions.filter((s) => now - Date.parse(s.lastSeenAt) <= PRESENCE_ON_MS).length;
    if (sessions > 0) out.push({ name: p.actor.name, sessions });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A decision a person records from Slack, as themselves. */
export async function decideAsPerson(db: Db, auth: AuthContext, room: string, text: string): Promise<Decision> {
  return postDecision(db, auth, { room, text });
}

/** An alert a person raises from Slack: raised and confirmed by them, with them as the source. */
export async function alertAsPerson(db: Db, auth: AuthContext, room: string, text: string): Promise<Alert> {
  const raised = await raiseAlert(db, auth, { room, text });
  return confirmAlert(db, auth, raised.id, {});
}

/** True when an answer was refused because the person is not someone the ask waits on. */
export function isNotAnswererError(e: unknown): boolean {
  return e instanceof BoardError && e.code === "approval_requires_person";
}
