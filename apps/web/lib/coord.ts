import { PRESENCE_ON_MS, type Alert, type ChangeEntry, type Presence, type Task, type TaskBlock, type Whoami } from "@copilotkit/teamkit-protocol";

/**
 * A short duration: "24m", "1h 5m", "3h" (minutes are dropped from 3 hours up), with minutes
 * rounded up so a few seconds read as "1m". Empty for zero, negative or non-finite input.
 */
export function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 || h >= 3 ? `${h}h` : `${h}h ${m}m`;
}

/** Time left on a ready task's hold (handed off, or its ask answered), or null when it has none. */
export function reservationLeft(task: Pick<Task, "state" | "reservedFor" | "reservedUntil">, now: number): string | null {
  if (task.state !== "ready" || !task.reservedFor || !task.reservedUntil) return null;
  const left = shortDuration(Date.parse(task.reservedUntil) - now);
  return left === "" ? null : left;
}

/** "Held for ben-agent · 24m" on a held card, "" once the hold lapses (the board's clock moves it). */
export function heldText(task: Pick<Task, "state" | "reservedFor" | "reservedUntil">, now: number): string {
  const left = reservationLeft(task, now);
  return left && task.reservedFor ? `Held for ${task.reservedFor.name} · ${left}` : "";
}

/** "sam", "sam or ana", "ana-agent, ben-agent and sam-agent". */
export function namesText(names: string[], joiner: "and" | "or"): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${joiner} ${names[names.length - 1]}`;
}

/** Who may answer: the named approvers, else the room's approvers, else null (any member). */
export function approverList(block: TaskBlock, roomApprovers: string[] | null): string[] | null {
  if (block.approvers && block.approvers.length > 0) return block.approvers;
  if (roomApprovers && roomApprovers.length > 0) return roomApprovers;
  return null;
}

/**
 * Whether `who` may answer this block, mirroring the server's answer rule so nobody clicks into a
 * refusal: an admin always may; with named people (either kind) only they may; a question with
 * nobody named is open to anyone; an approval with nobody named follows the room's approvers,
 * and is closed while that list is still loading (`undefined`). The server still decides.
 */
export function mayAnswer(block: TaskBlock, roomApprovers: string[] | null | undefined, who: Whoami): boolean {
  if (who.role === "admin") return true;
  if (block.approvers && block.approvers.length > 0) return block.approvers.includes(who.actor.name);
  if (block.kind !== "awaiting_approval") return true;
  if (roomApprovers === undefined) return false;
  const list = approverList(block, roomApprovers);
  return list === null || list.includes(who.actor.name);
}

/** The three views of one room. */
export type RoomTab = "board" | "decisions" | "changes";
export const ROOM_TABS: { tab: RoomTab; label: string }[] = [
  { tab: "board", label: "Board" },
  { tab: "decisions", label: "Decisions" },
  { tab: "changes", label: "Changes" },
];

/** The `?view=` value as a tab; anything else is the board. */
export function parseTab(v: string | null): RoomTab {
  return v === "decisions" || v === "changes" ? v : "board";
}

const ALL_ROOMS = "*";

/**
 * The query string that keeps the selected room (and the open tab) when a task opens or closes.
 * The room always rides in `?room=`, never in a path segment, since room names may contain `/`.
 */
export function roomQuery(room: string | null, tab?: RoomTab): string {
  if (!room || room === ALL_ROOMS) return "";
  const view = tab === "decisions" || tab === "changes" ? `&view=${tab}` : "";
  return `?room=${encodeURIComponent(room)}${view}`;
}

/** "No acks yet", "1 ack", "3 acks". */
export function ackText(n: number): string {
  return n === 0 ? "No acks yet" : n === 1 ? "1 ack" : `${n} acks`;
}

const CLOCK_TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** The time for something from today (local), the month and day for anything earlier. */
export function whenText(iso: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toDateString() === new Date(now).toDateString() ? CLOCK_TIME.format(d) : MONTH_DAY.format(d);
}

export const CHANGE_STATUS_LABEL: Record<ChangeEntry["status"], string> = { active: "Active", done: "Done", restored: "Restored" };

/** Active changes first (they may still need undoing), then newest first. Leaves `list` as it is. */
export function sortChanges(list: ChangeEntry[]): ChangeEntry[] {
  return [...list].sort((a, b) => {
    const live = Number(b.status === "active") - Number(a.status === "active");
    return live !== 0 ? live : b.at.localeCompare(a.at);
  });
}

/** Alerts the banner shows before "n more alerts". */
export const BANNER_MAX = 3;

/**
 * The banner's alerts: unresolved ones only (the server already sends open ones; this also drops
 * one resolved since the last load), confirmed before suspected, newest first, at any age.
 */
export function bannerAlerts(alerts: Alert[]): { shown: Alert[]; more: Alert[] } {
  const open = alerts
    .filter((a) => a.resolvedAt === null)
    .sort((a, b) => {
      const loud = Number(b.level === "confirmed") - Number(a.level === "confirmed");
      return loud !== 0 ? loud : b.createdAt.localeCompare(a.createdAt);
    });
  return { shown: open.slice(0, BANNER_MAX), more: open.slice(BANNER_MAX) };
}

/** Sessions seen within PRESENCE_ON_MS (the server's rule, shared with the Slack status message). */
export function liveSessions(p: Presence, now: number): number {
  return p.sessions.filter((s) => now - Date.parse(s.lastSeenAt) <= PRESENCE_ON_MS).length;
}

/** Agents with at least one live session, by name. People never count as on. */
export function agentsOn(list: Presence[], now: number): Presence[] {
  return list
    .filter((p) => p.actor.kind === "agent" && liveSessions(p, now) > 0)
    .sort((a, b) => a.actor.name.localeCompare(b.actor.name));
}

/** "ana-agent", or "ana-agent · 2 sessions" when more than one install is on. */
export function presenceLine(p: Presence, now: number): string {
  const n = liveSessions(p, now);
  return n > 1 ? `${p.actor.name} · ${n} sessions` : p.actor.name;
}
