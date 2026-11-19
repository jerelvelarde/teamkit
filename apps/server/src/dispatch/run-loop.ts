import { HttpAgent, type AgentSubscriber } from "@ag-ui/client";
import { EventType, type Interrupt, type Message } from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";
import {
  MAX_TEXT_LENGTH,
  boardToolDefinitions,
  isBoardTool,
  newId,
  type AguiEvent,
  type AguiMessage,
  type PendingResume,
} from "@copilotkit/teamkit-protocol";
import type { Db, Tx } from "../db/pool.js";
import type { AuthContext } from "../store/actors.js";
import { appendEvent } from "../store/events.js";
import { appendMessage } from "../store/rows.js";
import { executeBoardTool, type BoardToolCall } from "./board-tools.js";
import type { RegisteredAgent } from "./registry.js";

/** `delivered`: the first run reached RUN_FINISHED or RUN_ERROR, so the agent received `resume`. */
export type LoopOutcome =
  | { type: "success"; result: string | null; delivered: boolean }
  | {
      type: "interrupt";
      interrupt: { id: string; reason: string; message: string | null; options: string[] | null };
      delivered: boolean;
    }
  | { type: "agent_error"; message: string; code: string | null; delivered: boolean }
  | { type: "transport_error"; message: string; delivered: boolean }
  | { type: "too_many_rounds"; delivered: boolean }
  | { type: "unknown_tool"; names: string[]; delivered: boolean }
  | { type: "aborted"; delivered: boolean };

export interface RunLoopOptions {
  db: Db;
  agent: RegisteredAgent;
  auth: AuthContext;
  threadId: string;
  room: string;
  messages: AguiMessage[];
  context: { description: string; value: string }[];
  resume?: PendingResume[];
  claimId?: string;
  taskId?: string;
  signal?: AbortSignal;
  /** Runs per loop; each pending board tool call ends a run. Default 20. */
  maxRounds?: number;
  fetch?: typeof fetch;
}

const MAX_ROUNDS = 20;

type RunEnd =
  | { type: "success"; result: unknown; pendingToolCallIds: string[] }
  | { type: "interrupt"; interrupts: Interrupt[] }
  | { type: "cancelled" }
  | { type: "error"; message: string; code: string | null };

interface Round {
  data: Record<string, unknown>;
  /** The run's own RUN_FINISHED or RUN_ERROR, if it reached one. */
  end: RunEnd | null;
  /** onRunFailed and the runAgent rejection report one failure; this keeps the first. */
  failure: { error: unknown } | null;
  /** The first event the log could not take; later events of the run are not logged. */
  logFailure: { error: unknown } | null;
  newMessages: Message[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Cuts to MAX_TEXT_LENGTH without splitting a surrogate pair. */
export function clip(s: string): string {
  if (s.length <= MAX_TEXT_LENGTH) return s;
  const last = s.charCodeAt(MAX_TEXT_LENGTH - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_TEXT_LENGTH - 1 : MAX_TEXT_LENGTH);
}

// A NUL, or an unpaired UTF-16 surrogate: Postgres text and jsonb cannot store a NUL,
// and jsonb refuses a lone surrogate escape.
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * A copy with every NUL and unpaired surrogate replaced by U+FFFD, in strings and
 * object keys at any depth. Agents may stream either; the log and the thread must
 * still take the run.
 */
function scrub<T>(v: T): T {
  if (typeof v === "string") return v.replace(UNSTORABLE, "\uFFFD") as T;
  if (Array.isArray(v)) return v.map((x: unknown) => scrub(x)) as T;
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), scrub(x)])) as T;
  return v;
}

async function appendRunEvent(
  tx: Tx,
  o: RunLoopOptions,
  event: AguiEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const clean = scrub(event);
  const parsed = EventSchemas.safeParse(clean);
  if (!parsed.success) {
    throw new Error(`refusing to log an invalid AG-UI ${String(clean.type)} event: ${parsed.error.message}`);
  }
  await appendEvent(tx, {
    kind: "run.event",
    room: o.room,
    threadId: o.threadId,
    actorId: o.agent.actor.id,
    agui: [clean],
    data,
  });
}

/** The agent's copy keeps the raw message; the thread stores a scrubbed one. */
async function storeMessage(tx: Tx, o: RunLoopOptions, m: Message): Promise<void> {
  await appendMessage(tx, o.threadId, scrub(m));
}

function tagRunStarted(event: AguiEvent, o: RunLoopOptions): AguiEvent {
  const metadata = isRecord(event.metadata) ? event.metadata : {};
  const teamkit = { ...(o.claimId !== undefined ? { claimId: o.claimId } : {}), agent: o.agent.name };
  return { ...event, metadata: { ...metadata, teamkit } };
}

function attribute(m: Message, agent: RegisteredAgent): Message {
  if (m.role !== "assistant") return m;
  const out = { ...m };
  if (out.name === undefined) out.name = agent.name;
  if (!isRecord(out.metadata?.teamkit)) {
    const { id, name, kind } = agent.actor;
    out.metadata = { ...out.metadata, teamkit: { actorId: id, actorName: name, actorKind: kind } };
  }
  return out;
}

function resultText(result: unknown, messages: Message[]): string | null {
  if (result !== undefined && result !== null) {
    return clip(typeof result === "string" ? result : JSON.stringify(result));
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && typeof m.content === "string" && m.content !== "") return clip(m.content);
  }
  return null;
}

/** `responseSchema.properties.choice.enum` when it is a non-empty string array. */
function choiceOptions(schema: unknown): string[] | null {
  const props = isRecord(schema) ? schema.properties : undefined;
  const choice = isRecord(props) ? props.choice : undefined;
  const options = isRecord(choice) ? choice.enum : undefined;
  return Array.isArray(options) && options.length > 0 && options.every((x) => typeof x === "string")
    ? (options as string[])
    : null;
}

/** The pending calls in order; an id with no matching call in the messages gets name null. */
function pendingCalls(messages: Message[], ids: string[]): { id: string; name: string | null; args: string }[] {
  const byId = new Map<string, { name: string; args: string }>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const tc of m.toolCalls ?? []) byId.set(tc.id, { name: tc.function.name, args: tc.function.arguments });
  }
  return ids.map((id) => ({ id, name: byId.get(id)?.name ?? null, args: byId.get(id)?.args ?? "" }));
}

async function runRound(o: RunLoopOptions, http: HttpAgent, round: number): Promise<Round> {
  const runId = newId("run");
  const data: Record<string, unknown> = {
    runId,
    agent: o.agent.name,
    round,
    ...(o.claimId !== undefined ? { claimId: o.claimId } : {}),
    ...(o.taskId !== undefined ? { taskId: o.taskId } : {}),
  };
  const st: Pick<Round, "end" | "failure" | "logFailure"> = { end: null, failure: null, logFailure: null };
  const known = new Set(http.messages.map((m) => m.id));

  // One chain keeps the log in stream order. It never rejects: the first failed
  // append is kept and the rest of the run's events are skipped.
  let chain: Promise<void> = Promise.resolve();
  const log = (event: AguiEvent) => {
    chain = chain.then(async () => {
      if (st.logFailure) return;
      try {
        await o.db.begin((tx) => appendRunEvent(tx, o, event, data));
      } catch (error) {
        st.logFailure = { error };
      }
    });
  };

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  if (o.signal?.aborted) abortController.abort();
  // After an abort HttpAgent reports a RUN_ERROR of its own (code "abort"); it is not the agent's.
  const live = () => !abortController.signal.aborted;

  const subscriber: AgentSubscriber = {
    onEvent({ event }) {
      if (!live()) return;
      const copy = structuredClone(event) as AguiEvent;
      log(copy.type === EventType.RUN_STARTED ? tagRunStarted(copy, o) : copy);
    },
    onRunFinishedEvent(p) {
      if (!live() || st.end) return;
      if (p.outcome === "success") {
        st.end = { type: "success", result: p.result, pendingToolCallIds: p.pendingToolCallIds };
      } else if (p.outcome === "interrupt") {
        st.end = { type: "interrupt", interrupts: p.interrupts };
      } else {
        st.end = { type: "cancelled" };
      }
    },
    onRunErrorEvent({ event }) {
      if (!live() || st.end) return;
      st.end = { type: "error", message: event.message, code: event.code ?? null };
    },
    onRunFailed({ error }) {
      st.failure ??= { error };
    },
  };

  try {
    await http.runAgent(
      {
        runId,
        tools: boardToolDefinitions,
        context: o.context,
        forwardedProps: {},
        resume: round === 1 ? o.resume : undefined,
        abortController,
      },
      subscriber,
    );
  } catch (error) {
    // A dropped stream fires onRunFailed AND rejects: still one failure.
    st.failure ??= { error };
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
  }
  await chain;
  // The set runAgent returns as newMessages, taken here so that a run whose stream
  // broke after its RUN_FINISHED still has them.
  return { ...st, data, newMessages: http.messages.filter((m) => !known.has(m.id)) };
}

async function persistMessages(o: RunLoopOptions, messages: Message[]): Promise<void> {
  if (messages.length === 0) return;
  await o.db.begin(async (tx) => {
    for (const m of messages) await storeMessage(tx, o, attribute(m, o.agent));
  });
}

/** Runs one board tool call as the agent and hands the result back for the next run. */
async function answerCall(
  o: RunLoopOptions,
  http: HttpAgent,
  call: BoardToolCall,
  data: Record<string, unknown>,
): Promise<void> {
  const { content } = await executeBoardTool(o.db, o.auth, call);
  const messageId = newId("msg");
  const message: Message = { id: messageId, role: "tool", toolCallId: call.id, content };
  http.addMessage(message);
  const event: AguiEvent = { type: EventType.TOOL_CALL_RESULT, messageId, toolCallId: call.id, content, role: "tool" };
  await o.db.begin(async (tx) => {
    await storeMessage(tx, o, message);
    await appendRunEvent(tx, o, event, data);
  });
}

/**
 * Runs a registered AG-UI agent on a thread: board tools go in as client-side
 * tools, every streamed event is logged as `run.event`, new messages are stored on
 * the thread, and each run that ends with pending board tool calls has them
 * carried out as the agent before the next run. Every string the agent supplied is
 * scrubbed (NUL and unpaired surrogates become U+FFFD) before it is stored or
 * returned in the outcome. Never throws.
 */
export async function runAgentLoop(o: RunLoopOptions): Promise<LoopOutcome> {
  return scrub(await loop(o));
}

async function loop(o: RunLoopOptions): Promise<LoopOutcome> {
  const maxRounds = o.maxRounds ?? MAX_ROUNDS;
  const http = new HttpAgent({
    url: o.agent.url,
    headers: o.agent.headers,
    threadId: o.threadId,
    initialMessages: o.messages,
    fetch: o.fetch,
  });
  let delivered = false;
  try {
    for (let round = 1; round <= maxRounds; round++) {
      if (o.signal?.aborted) return { type: "aborted", delivered };
      const r = await runRound(o, http, round);
      if (round === 1 && r.end) delivered = true;
      if (o.signal?.aborted) return { type: "aborted", delivered };
      if (r.logFailure) return { type: "transport_error", message: errorMessage(r.logFailure.error), delivered };
      // A terminal event that arrived decides the run, even if the stream broke after it.
      if (!r.end) {
        const message = r.failure
          ? errorMessage(r.failure.error)
          : "the agent's stream ended without RUN_FINISHED or RUN_ERROR";
        return { type: "transport_error", message, delivered };
      }
      await persistMessages(o, r.newMessages);
      const end = r.end;
      switch (end.type) {
        case "error":
          return { type: "agent_error", message: end.message, code: end.code, delivered };
        case "cancelled":
          return { type: "agent_error", message: "the agent cancelled its run", code: null, delivered };
        case "interrupt": {
          const it = end.interrupts[0];
          if (!it) {
            return { type: "agent_error", message: "the agent's interrupt outcome named no interrupt", code: null, delivered };
          }
          return {
            type: "interrupt",
            interrupt: { id: it.id, reason: it.reason, message: it.message ?? null, options: choiceOptions(it.responseSchema) },
            delivered,
          };
        }
        case "success": {
          if (end.pendingToolCallIds.length === 0) {
            return { type: "success", result: resultText(end.result, http.messages), delivered };
          }
          const board: BoardToolCall[] = [];
          const unknown = new Set<string>();
          for (const c of pendingCalls(http.messages, end.pendingToolCallIds)) {
            // A pending id with no matching call in the messages is reported by its id.
            if (c.name !== null && isBoardTool(c.name)) board.push({ id: c.id, name: c.name, args: c.args });
            else unknown.add(c.name ?? c.id);
          }
          if (unknown.size > 0) return { type: "unknown_tool", names: [...unknown], delivered };
          for (const call of board) await answerCall(o, http, call, r.data);
        }
      }
    }
    return { type: "too_many_rounds", delivered };
  } catch (e) {
    if (o.signal?.aborted) return { type: "aborted", delivered };
    return { type: "transport_error", message: errorMessage(e), delivered };
  }
}
