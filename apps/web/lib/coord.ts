import type { Task, TaskBlock, Whoami } from "@copilotkit/teamkit-protocol";

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
