import type { BoardEvent, RoomView, Task, ThreadView } from "@copilotkit/teamkit-protocol";

export function firstLine(s: string, max = 80): string {
  const line = s.split(/\r?\n/, 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function formatTask(t: Task): string {
  let out = `${t.id}  [${t.state}]  ${t.room}  ${firstLine(t.brief)}`;
  const labels = Object.entries(t.labels);
  if (labels.length > 0) out += ` labels ${labels.map(([k, v]) => `${k}=${v}`).join(",")}`;
  if (t.claim) out += ` claimed by ${t.claim.actor.name} until ${t.claim.leaseExpiresAt}`;
  if (t.needs.length > 0) {
    out += ` needs: ${t.needs.map((id) => `${id}(${t.needStates[id] ?? "unknown"})`).join(",")}`;
  }
  if (t.block) out += ` blocked: ${t.block.question}`;
  return out;
}

export function formatTaskList(tasks: Task[]): string {
  return tasks.length === 0 ? "no tasks" : tasks.map(formatTask).join("\n");
}

export function formatEvent(e: BoardEvent): string {
  return `${e.cursor}  ${e.kind}  ${e.room}  ${e.threadId ?? "-"}  ${e.actor?.name ?? "system"}`;
}

export function formatThread(v: ThreadView): string {
  const state = v.task?.state ?? "discussion";
  const header = `${v.thread.id}  ${v.thread.room}  [${state}]`;
  const lines = v.messages.map((m) => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    return `${(m as { name?: string }).name ?? m.role}: ${content}`;
  });
  return [header, ...lines].join("\n");
}

export function formatRoom(v: RoomView): string {
  const lines = v.threads.map(
    (t) => `${t.id}  [${t.state ?? "discussion"}]  ${firstLine(t.brief ?? "")}`.trimEnd(),
  );
  return [v.room.name, ...lines].join("\n");
}
