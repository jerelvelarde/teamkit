/**
 * The one-line replies TeamKit posts in a task's Slack thread, and the refusal a person sees when
 * an ask does not wait on them. Every value that came from a person or an agent is escaped, so it
 * cannot ping anyone or turn into a link; the only live mention is the confirmed alert's `<!here>`.
 */
import type { ActorRef, Alert, ChangeEntry } from "@copilotkit/teamkit-protocol";
import { escapeMrkdwn as esc } from "./cards.js";

const PROGRESS_MAX = 1500;
const TEXT_MAX = 2000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "by", or "by for source" when someone acted for another (an agent for its owner). */
function forWhom(by: ActorRef, source: ActorRef | null): string {
  return source && source.id !== by.id ? `${esc(by.name)} for ${esc(source.name)}` : esc(by.name);
}

export function claimedLine(by: string): string {
  return `${esc(by)} claimed this task.`;
}

export function answeredLine(by: string, said: string): string {
  return `${esc(by)} answered: ${esc(clip(said, PROGRESS_MAX))}`;
}

export function handoffLine(from: string, to: string, heldMinutes: number | null): string {
  const base = `${esc(from)} handed this task to ${esc(to)}.`;
  return heldMinutes === null ? base : `${base} It is held for ${esc(to)} for ${heldMinutes} min.`;
}

export function progressLine(by: string, text: string): string {
  return `*${esc(by)}:* ${esc(clip(text, PROGRESS_MAX))}`;
}

export function changeLoggedLine(c: ChangeEntry): string {
  const who = c.agent ? `${esc(c.agent.name)} for ${esc(c.person.name)}` : esc(c.person.name);
  const parts = [
    `Change logged by ${who}: ${esc(clip(c.what, TEXT_MAX))}`,
    `where: ${esc(c.where)}`,
    `undo: ${esc(clip(c.undo, TEXT_MAX))}`,
    ...(c.undoWhen ? [`undo when: ${esc(c.undoWhen)}`] : []),
  ];
  return parts.join(" · ");
}

export function changeUpdatedLine(c: ChangeEntry, by: string): string {
  return `${esc(by)} marked a change ${esc(c.status)}: ${esc(clip(c.what, TEXT_MAX))}`;
}

/** The reply on a suspected alert's thread once it is confirmed; it carries the one `<!here>`. */
export function alertConfirmedLine(a: Alert): string {
  const by = a.confirmedBy ? forWhom(a.confirmedBy, a.source) : "a person";
  return `<!here> Confirmed by ${by}: ${esc(clip(a.text, TEXT_MAX))}`;
}

/** What a person sees when they press an answer button on an ask that does not wait on them. */
export function refusalLine(waitsOn: string[] | null): string {
  if (!waitsOn || waitsOn.length === 0) return "Only a listed approver or an admin can answer this.";
  const names = waitsOn.map(esc);
  if (names.length === 1) return `This waits on ${names[0]}. Only ${names[0]} or an admin can answer it.`;
  return `This waits on ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}. Only they or an admin can answer it.`;
}
