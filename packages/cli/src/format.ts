import type { BoardEvent, RoomView, Task, ThreadView } from "@copilotkit/teamkit-protocol";

export function firstLine(s: string, max = 80): string {
  const line = s.split(/\r?\n/, 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function formatBlock(b: NonNullable<Task["block"]>): string {
  const options = b.options && b.options.length > 0 ? ` [options: ${b.options.join("|")}]` : "";
  return `blocked (${b.kind}): ${b.question}${options}`;
}

export function formatTask(t: Task): string {
  let out = `${t.id}  [${t.state}]  ${t.room}  ${firstLine(t.brief)}`;
  const labels = Object.entries(t.labels);
  if (labels.length > 0) out += ` labels ${labels.map(([k, v]) => `${k}=${v}`).join(",")}`;
  if (t.claim) out += ` claimed by ${t.claim.actor.name} until ${t.claim.leaseExpiresAt}`;
  if (t.needs.length > 0) {
    out += ` needs: ${t.needs.map((id) => `${id}(${t.needStates[id] ?? "unknown"})`).join(",")}`;
  }
  if (t.block) out += ` ${formatBlock(t.block)}`;
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
  const task = v.task;
  const meta: string[] = [];
  if (task) {
    const labels = Object.entries(task.labels);
    if (labels.length > 0) meta.push(`labels: ${labels.map(([k, val]) => `${k}=${val}`).join(",")}`);
    if (task.needs.length > 0) {
      meta.push(`needs: ${task.needs.map((id) => `${id}(${task.needStates[id] ?? "unknown"})`).join(" ")}`);
    }
    if (task.block) meta.push(formatBlock(task.block));
    if (task.state === "completed" && task.result) meta.push(`result: ${task.result}`);
  }
  const lines = v.messages.map((m) => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    return `${(m as { name?: string }).name ?? m.role}: ${content}`;
  });
  return [header, ...meta, ...lines, `cursor: ${v.cursor}`].join("\n");
}

export function formatRoom(v: RoomView): string {
  const lines = v.threads.map((t) => `${t.id}  [${t.state ?? "discussion"}]  ${firstLine(t.brief ?? "")}`.trimEnd());
  return [v.room.name, ...lines].join("\n");
}
