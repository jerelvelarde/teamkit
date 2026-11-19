import type { BoardEvent } from "@copilotkit/teamkit-protocol";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";
export interface ActorView {
  name: string;
  kind: "agent" | "person";
}
export type ViewItem =
  | {
      kind: "message";
      id: string;
      role: string;
      text: string;
      actor: ActorView | null;
      streaming: boolean;
      cursor: string;
    }
  | { kind: "tool"; id: string; name: string; args: string; result: string | null; cursor: string }
  | { kind: "reasoning"; id: string; text: string; cursor: string }
  | { kind: "status"; id: string; label: string; tone: Tone; detail: string | null; cursor: string }
  | {
      kind: "subagent";
      id: string;
      name: string;
      status: "running" | "finished" | "error";
      detail: string | null;
      items: ViewItem[];
      cursor: string;
    };
export interface PendingQuestion {
  interruptId: string;
  reason: string;
  message: string;
  options: string[] | null;
}
export interface ThreadViewModel {
  items: ViewItem[];
  question: PendingQuestion | null;
  lastCursor: string;
}

type Rec = Record<string, unknown>;
type Item<K extends ViewItem["kind"]> = Extract<ViewItem, { kind: K }>;

/** One list of items plus the lookups that route later events to them (top level, or one subagent). */
interface Scope {
  items: ViewItem[];
  messages: Map<string, Item<"message">>;
  tools: Map<string, Item<"tool">>;
  reasoning: Map<string, Item<"reasoning">>;
}

function newScope(items: ViewItem[] = []): Scope {
  return { items, messages: new Map(), tools: new Map(), reasoning: new Map() };
}

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function show(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

/**
 * Who wrote a message. The server records the poster on every BoardEvent, and that wins:
 * `metadata.teamkit` sits inside the AG-UI event the poster wrote, so an agent could put any
 * name there. The metadata is read only for an event with no recorded actor.
 */
function actorFrom(ev: Rec, recorded: BoardEvent["actor"]): ActorView | null {
  if (isRec(recorded)) {
    const n = str(recorded.name);
    return n && (recorded.kind === "agent" || recorded.kind === "person") ? { name: n, kind: recorded.kind } : null;
  }
  const meta = isRec(ev.metadata) && isRec(ev.metadata.teamkit) ? ev.metadata.teamkit : null;
  const name = meta ? str(meta.actorName) : null;
  const kind = meta ? meta.actorKind : null;
  return name && (kind === "agent" || kind === "person") ? { name, kind } : null;
}

/**
 * Message, tool call, reasoning and subagent ids are chosen by whoever posts, so they are
 * scoped to the recorded actor: reusing someone else's id starts a new item instead of
 * writing into theirs.
 */
function ownKey(actor: BoardEvent["actor"], id: string): string {
  const actorId = isRec(actor) ? str(actor.id) : null;
  return actorId ? `${actorId}:${id}` : id;
}

function nameOf(v: unknown, fallback: string): string {
  return (isRec(v) ? str(v.name) : null) ?? fallback;
}

function choicesOf(schema: unknown): string[] | null {
  if (!isRec(schema) || !isRec(schema.properties) || !isRec(schema.properties.choice)) return null;
  const e = schema.properties.choice.enum;
  return Array.isArray(e) && e.every((x) => typeof x === "string") ? (e as string[]) : null;
}

/** AG-UI 1.0 writes `outcome: {type}`; accept a bare string too. */
function outcomeType(ev: Rec): string | null {
  return isRec(ev.outcome) ? str(ev.outcome.type) : str(ev.outcome);
}

function interruptsOf(ev: Rec): unknown[] {
  if (isRec(ev.outcome) && Array.isArray(ev.outcome.interrupts)) return ev.outcome.interrupts;
  return Array.isArray(ev.interrupts) ? ev.interrupts : [];
}

/**
 * A run.event is an agent's own stream, logged as it sent it. TeamKit's state changes
 * (`teamkit.*` CUSTOM names and RUN_ERROR codes) count only from the board's own events, and
 * an agent's messages are its own turns whatever role they claim.
 */
const fromAgentRun = (be: BoardEvent) => be.kind === "run.event";

class Folder {
  top = newScope();
  question: PendingQuestion | null = null;
  groups = new Map<string, { item: Item<"subagent">; scope: Scope }>();

  fold(be: BoardEvent): void {
    const cursor = str(be.cursor) ?? "0";
    const agui: unknown[] = Array.isArray(be.agui) ? be.agui : [];
    const trusted = !fromAgentRun(be);
    agui.forEach((ev, index) => {
      if (!isRec(ev)) return;
      try {
        this.event(ev, cursor, index, be.actor ?? null, trusted);
      } catch {
        // A malformed event must never break the thread.
      }
    });
  }

  private status(
    scope: Scope,
    cursor: string,
    index: number,
    label: string,
    tone: Tone,
    detail: string | null = null,
  ): void {
    // One block asks once: the stored question and the interrupt both say "Waiting: ...". Skip a chip
    // identical to the previous one, looking back past plain messages only.
    for (let i = scope.items.length - 1; i >= 0; i--) {
      const prev = scope.items[i]!;
      if (prev.kind === "message") continue;
      if (prev.kind === "status" && prev.label === label && prev.tone === tone && prev.detail === detail) return;
      break;
    }
    scope.items.push({ kind: "status", id: `status-${cursor}-${index}`, label, tone, detail, cursor });
  }

  private ask(interruptId: string, reason: string, message: string, options: string[] | null): void {
    this.question = { interruptId, reason, message, options };
  }

  private event(ev: Rec, cursor: string, index: number, actor: BoardEvent["actor"], trusted: boolean): void {
    const type = str(ev.type);
    if (!type) return;
    const sub = str(ev.subagentRunId);

    // Subagent lifecycle events name their own group in subagentRunId.
    const group = sub ? ownKey(actor, sub) : null;
    if (type === "SUBAGENT_STARTED") {
      if (!group || this.groups.has(group)) return;
      const item: Item<"subagent"> = {
        kind: "subagent",
        id: group,
        name: str(ev.name) ?? "subagent",
        status: "running",
        detail: str(ev.description),
        items: [],
        cursor,
      };
      this.groups.set(group, { item, scope: newScope(item.items) });
      this.top.items.push(item);
      return;
    }
    if (type === "SUBAGENT_FINISHED" || type === "SUBAGENT_ERROR") {
      const g = group ? this.groups.get(group) : undefined;
      if (!g) return;
      if (type === "SUBAGENT_FINISHED") {
        g.item.status = str(ev.outcome) === "error" ? "error" : "finished";
        g.item.detail = str(ev.result) ?? g.item.detail;
      } else {
        g.item.status = "error";
        g.item.detail = str(ev.message) ?? g.item.detail;
      }
      return;
    }

    const scope = (group ? this.groups.get(group)?.scope : undefined) ?? this.top;
    switch (type) {
      case "TEXT_MESSAGE_START":
      case "TEXT_MESSAGE_CONTENT":
      case "TEXT_MESSAGE_CHUNK":
      case "TEXT_MESSAGE_END":
        return this.text(ev, type, scope, cursor, actor, trusted);
      case "TOOL_CALL_START":
      case "TOOL_CALL_ARGS":
      case "TOOL_CALL_END":
      case "TOOL_CALL_RESULT":
        return this.tool(ev, type, scope, cursor, actor);
      case "REASONING_MESSAGE_START":
      case "REASONING_MESSAGE_CONTENT":
      case "REASONING_MESSAGE_END":
        return this.reason(ev, type, scope, cursor, actor);
      case "RUN_STARTED":
        this.question = null;
        return this.status(scope, cursor, index, "Run started", "info");
      case "RUN_FINISHED":
        return this.runFinished(ev, scope, cursor, index);
      case "RUN_ERROR":
        return this.runError(ev, scope, cursor, index, trusted);
      case "CUSTOM":
        return this.custom(ev, scope, cursor, index, trusted);
      default:
        return; // STEP_*, STATE_*, MESSAGES_SNAPSHOT, ACTIVITY_*, RAW, unknown
    }
  }

  private text(
    ev: Rec,
    type: string,
    scope: Scope,
    cursor: string,
    actor: BoardEvent["actor"],
    trusted: boolean,
  ): void {
    const messageId = str(ev.messageId);
    if (!messageId) return;
    const id = ownKey(actor, messageId);
    const ensure = (streaming: boolean): Item<"message"> => {
      let m = scope.messages.get(id);
      if (!m) {
        m = {
          kind: "message",
          id,
          role: (trusted && str(ev.role)) || "assistant",
          text: "",
          actor: actorFrom(ev, actor),
          streaming,
          cursor,
        };
        scope.messages.set(id, m);
        scope.items.push(m);
      }
      return m;
    };
    if (type === "TEXT_MESSAGE_START") {
      ensure(true);
    } else if (type === "TEXT_MESSAGE_CONTENT") {
      ensure(true).text += str(ev.delta) ?? "";
    } else if (type === "TEXT_MESSAGE_CHUNK") {
      ensure(false).text += str(ev.delta) ?? "";
    } else {
      const m = scope.messages.get(id);
      if (m) m.streaming = false;
    }
  }

  private tool(ev: Rec, type: string, scope: Scope, cursor: string, actor: BoardEvent["actor"]): void {
    const toolCallId = str(ev.toolCallId);
    if (!toolCallId) return;
    const id = ownKey(actor, toolCallId);
    let t = scope.tools.get(id);
    if (!t) {
      if (type === "TOOL_CALL_END") return;
      t = { kind: "tool", id, name: str(ev.toolCallName) ?? "tool", args: "", result: null, cursor };
      scope.tools.set(id, t);
      scope.items.push(t);
    }
    if (type === "TOOL_CALL_START" && str(ev.toolCallName)) t.name = str(ev.toolCallName) as string;
    if (type === "TOOL_CALL_ARGS") t.args += str(ev.delta) ?? "";
    if (type === "TOOL_CALL_RESULT") t.result = show(ev.content);
  }

  private reason(ev: Rec, type: string, scope: Scope, cursor: string, actor: BoardEvent["actor"]): void {
    const messageId = str(ev.messageId);
    if (!messageId || type === "REASONING_MESSAGE_END") return;
    const id = ownKey(actor, messageId);
    let r = scope.reasoning.get(id);
    if (!r) {
      r = { kind: "reasoning", id, text: "", cursor };
      scope.reasoning.set(id, r);
      scope.items.push(r);
    }
    if (type === "REASONING_MESSAGE_CONTENT") r.text += str(ev.delta) ?? "";
  }

  private runFinished(ev: Rec, scope: Scope, cursor: string, index: number): void {
    const outcome = outcomeType(ev);
    if (outcome === "interrupt") {
      const first = interruptsOf(ev).find(isRec);
      const message = (first && str(first.message)) ?? "";
      const id = first ? str(first.id) : null;
      if (id) this.ask(id, str(first?.reason) ?? "", message, choicesOf(first?.responseSchema));
      return this.status(scope, cursor, index, message ? `Waiting: ${message}` : "Waiting", "warning");
    }
    if (outcome === "cancelled") return this.status(scope, cursor, index, "Run cancelled", "neutral");
    this.question = null;
    this.status(scope, cursor, index, "Run finished", "success", str(ev.result));
  }

  private runError(ev: Rec, scope: Scope, cursor: string, index: number, trusted: boolean): void {
    const message = str(ev.message);
    switch (trusted ? str(ev.code) : null) {
      case "teamkit.released":
        return this.status(scope, cursor, index, "Released", "neutral");
      case "teamkit.lease_expired":
        return this.status(scope, cursor, index, "Claim expired", "warning");
      case "teamkit.failed":
        return this.status(scope, cursor, index, "Failed", "danger", message);
      default:
        return this.status(scope, cursor, index, "Run error", "danger", message);
    }
  }

  private custom(ev: Rec, scope: Scope, cursor: string, index: number, trusted: boolean): void {
    const name = str(ev.name);
    if (!name) return;
    const value = isRec(ev.value) ? ev.value : {};
    const s = (label: string, tone: Tone, detail: string | null = null) =>
      this.status(scope, cursor, index, label, tone, detail);
    if (!trusted && name.startsWith("teamkit.")) return s(name, "neutral");
    switch (name) {
      case "teamkit.task.created":
        return s("Task created", "info");
      case "teamkit.task.claimed":
        return s(`Claimed by ${nameOf(value.actor, "an agent")}`, "info");
      case "teamkit.interrupt.answered":
        this.question = null;
        return s(`Answered by ${nameOf(value.by, "someone")}`, "success");
      case "teamkit.task.ready":
        return s("Ready", "info");
      case "teamkit.label":
        return s(`Label ${show(value.key)}=${show(value.value)}`, "neutral");
      case "teamkit.task.blocked": {
        const question = str(value.question) ?? "";
        const id = str(value.interruptId);
        if (id) {
          const options = Array.isArray(value.options) && value.options.every((o) => typeof o === "string");
          this.ask(id, str(value.kind) ?? "", question, options ? (value.options as string[]) : null);
        }
        return s(question ? `Waiting: ${question}` : "Waiting", "warning");
      }
      case "teamkit.task.completed":
        this.question = null;
        return s("Completed", "success");
      case "teamkit.task.failed":
        return s("Failed", "danger", str(value.reason));
      case "teamkit.task.released":
        return s("Released", "neutral");
      case "teamkit.task.lease_expired":
        return s("Claim expired", "warning");
      case "teamkit.trigger.fired":
        return s("Woken by a trigger", "info");
      case "teamkit.thread.created":
      case "teamkit.message.posted":
        return;
      default:
        return s(name, "neutral");
    }
  }
}

/** Folds the board's event log for one thread into what the thread view draws. Never throws. */
export function foldEvents(events: BoardEvent[]): ThreadViewModel {
  const list: unknown[] = Array.isArray(events) ? events : [];
  const folder = new Folder();
  let lastCursor = "0";
  for (const be of list) {
    if (!isRec(be)) continue;
    try {
      folder.fold(be as unknown as BoardEvent);
    } catch {
      // keep going: one bad event must not hide the rest of the thread
    }
    lastCursor = str(be.cursor) ?? lastCursor;
  }
  return { items: folder.top.items, question: folder.question, lastCursor };
}
