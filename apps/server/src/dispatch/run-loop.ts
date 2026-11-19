import { HttpAgent, type AgentSubscriber } from "@ag-ui/client";
import { EventType, type Interrupt, type Message } from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";
import {
  BoardError,
  MAX_TEXT_LENGTH,
  boardToolDefinitions,
  isBoardError,
  isBoardTool,
  newId,
  type AguiEvent,
  type AguiMessage,
  type PendingResume,
} from "@copilotkit/teamkit-protocol";
import type { Db, Q, Tx } from "../db/pool.js";
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
  | { type: "too_many_tool_calls"; count: number; delivered: boolean }
  | { type: "unknown_tool"; names: string[]; delivered: boolean }
  /** The task's claim moved on (`claimId` no longer holds it); the run was stopped and wrote nothing more. */
  | { type: "claim_lost"; delivered: boolean }
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
  /** With taskId: every write the run makes first checks that this claim still holds the task. */
  claimId?: string;
  taskId?: string;
  signal?: AbortSignal;
  /** Runs per loop; each pending board tool call ends a run. Default 20. */
  maxRounds?: number;
  /** A run that sends no event for this long is stopped as a transport error. Default TEAMKIT_AGENT_IDLE_MS, else 120000. */
  idleMs?: number;
  /** The whole loop, board tool rounds included, is stopped as a transport error past this. Default TEAMKIT_AGENT_MAX_RUN_MS, else 1800000. */
  maxRunMs?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

const MAX_ROUNDS = 20;
/** One run (one request to the agent) may stream at most this many bytes and events. */
export const MAX_RUN_BYTES = 5 * 1024 * 1024;
export const MAX_RUN_EVENTS = 5000;
/** Board tool calls one run may leave pending. */
export const MAX_TOOL_CALLS = 20;
/** How much of an agent's HTTP error body goes into the failure reason. */
const ERROR_BODY_BYTES = 4096;
const IDLE_MS_DEFAULT = 120_000;
const MAX_RUN_MS_DEFAULT = 30 * 60_000;
/** setTimeout fires at once past this. */
const MAX_TIMER_MS = 2_147_483_647;

/** A positive whole number of ms from the environment, read at call time so tests can change it. */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** Why TeamKit stopped a run itself. */
type Halt =
  | { type: "agent_error"; message: string; code: null }
  | { type: "transport_error"; message: string }
  | { type: "claim_lost" };

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
  /** The first reason TeamKit stopped the run: a limit, a failed log write, or a lost claim. */
  halt: Halt | null;
  newMessages: Message[];
}

/** What every round of one loop shares. */
interface Limits {
  idleMs: number;
  maxRunMs: number;
  deadline: number;
  /** Set by the round in flight; the guarded fetch calls it when the stream passes MAX_RUN_BYTES. */
  onTooManyBytes: () => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const isClaimLost = (e: unknown) => isBoardError(e) && e.code === "claim_lost";

const duration = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);

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

/**
 * Locks the task row and checks the run's claim still holds it. A run that is not on a
 * claimed task checks nothing. Called first in every transaction the run writes in, so a
 * stale run cannot write past a reap and re-claim: the reaper and the new claim take the
 * same row lock.
 */
async function holdClaim(q: Q, o: RunLoopOptions): Promise<void> {
  if (o.claimId === undefined || o.taskId === undefined) return;
  const [row] = await q<{ state: string; claim_id: string | null }[]>`
    select state, claim_id from tasks where thread_id = ${o.taskId} for update`;
  if (row?.state !== "claimed" || row.claim_id !== o.claimId) {
    throw new BoardError("claim_lost", `claim ${o.claimId} on ${o.taskId} no longer holds the task`);
  }
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

/**
 * What the log keeps of an event the agent sent. `teamkit.*` CUSTOM names and RUN_ERROR
 * codes are what TeamKit itself writes when a task changes state: an agent's own get an
 * `agent.` prefix, so its stream cannot pass for one. `metadata.teamkit` is TeamKit's too
 * and is dropped, and a text message speaks as the agent whatever role or name it claims.
 */
function fromAgent(event: AguiEvent, o: RunLoopOptions): AguiEvent {
  if (event.type === EventType.RUN_STARTED) return tagRunStarted(event, o);
  const out = { ...event };
  if (isRecord(out.metadata) && "teamkit" in out.metadata) {
    const { teamkit: _, ...metadata } = out.metadata;
    out.metadata = metadata;
  }
  if (out.type === EventType.CUSTOM && typeof out.name === "string" && out.name.startsWith("teamkit.")) {
    out.name = `agent.${out.name}`;
  }
  if (out.type === EventType.RUN_ERROR && typeof out.code === "string" && out.code.startsWith("teamkit.")) {
    out.code = `agent.${out.code}`;
  }
  if (out.type === EventType.TEXT_MESSAGE_START || out.type === EventType.TEXT_MESSAGE_CHUNK) {
    if (out.role !== undefined) out.role = "assistant";
    if (out.name !== undefined) out.name = o.agent.name;
  }
  return out;
}

function clipContent<M extends { content?: unknown }>(m: M): M {
  return typeof m.content === "string" ? { ...m, content: clip(m.content) } : m;
}

/** Tool-call arguments past MAX_TEXT_LENGTH become a marker, since a cut-off string is not JSON. */
function clipToolCalls(m: Extract<Message, { role: "assistant" }>): Message {
  if (!m.toolCalls?.some((tc) => tc.function.arguments.length > MAX_TEXT_LENGTH)) return m;
  return {
    ...m,
    toolCalls: m.toolCalls.map((tc) =>
      tc.function.arguments.length > MAX_TEXT_LENGTH
        ? { ...tc, function: { ...tc.function, arguments: '{"_clipped":true}' } }
        : tc,
    ),
  };
}

/**
 * What the thread keeps of a message the agent's run produced, or null to drop it. An agent
 * speaks only as itself: its assistant messages get its name and actor whatever they
 * claimed, and the results of its own (non-board) tool calls in this run are kept. User,
 * system, developer, activity and reasoning messages, and results for board tool calls
 * (TeamKit stores those itself), are dropped.
 */
function storable(m: Message, agent: RegisteredAgent, ownCalls: Set<string>): Message | null {
  if (m.role === "assistant") {
    const { id, name, kind } = agent.actor;
    const metadata = isRecord(m.metadata) ? m.metadata : {};
    return clipContent(
      clipToolCalls({
        ...m,
        name: agent.name,
        metadata: { ...metadata, teamkit: { actorId: id, actorName: name, actorKind: kind } },
      }),
    );
  }
  if (m.role === "tool" && ownCalls.has(m.toolCallId)) {
    // metadata.teamkit is TeamKit's attribution; a tool message carries none.
    const { teamkit: _, ...metadata } = isRecord(m.metadata) ? m.metadata : ({} as Record<string, unknown>);
    return clipContent({ ...m, metadata });
  }
  return null;
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

/** At most `max` bytes of a body, decoded as UTF-8; the rest is never read. */
async function readPrefix(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

/**
 * The fetch HttpAgent uses: redirects are refused (one would carry the agent's headers to
 * another host), an error body is read only up to ERROR_BODY_BYTES, and a stream past
 * MAX_RUN_BYTES is cut off.
 */
function guardedFetch(base: typeof fetch, limits: Limits): typeof fetch {
  return async (input, init) => {
    let res: Response;
    try {
      res = await base(input, { ...init, redirect: "error" });
    } catch (e) {
      // Node reports a refused redirect as "fetch failed" with the reason in `cause`.
      if (e instanceof TypeError && e.cause instanceof Error) throw new TypeError(`${e.message}: ${e.cause.message}`);
      throw e;
    }
    if (!res.ok) {
      const headers = new Headers();
      const type = res.headers.get("content-type");
      if (type) headers.set("content-type", type);
      const body = await readPrefix(res, ERROR_BODY_BYTES);
      return new Response(body, { status: res.status, statusText: res.statusText, headers });
    }
    if (!res.body) return res;
    let seen = 0;
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > MAX_RUN_BYTES) {
            limits.onTooManyBytes();
            controller.error(new Error("run too large"));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

async function runRound(o: RunLoopOptions, http: HttpAgent, round: number, limits: Limits): Promise<Round> {
  const runId = newId("run");
  const data: Record<string, unknown> = {
    runId,
    agent: o.agent.name,
    round,
    ...(o.claimId !== undefined ? { claimId: o.claimId } : {}),
    ...(o.taskId !== undefined ? { taskId: o.taskId } : {}),
  };
  const st: Pick<Round, "end" | "failure" | "halt"> = { end: null, failure: null, halt: null };
  const known = new Set(http.messages.map((m) => m.id));

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  if (o.signal?.aborted) abortController.abort();
  // After an abort HttpAgent reports a RUN_ERROR of its own (code "abort"); it is not the agent's.
  const live = () => !abortController.signal.aborted;
  /** Stops the run at once; the first reason wins. */
  const halt = (why: Halt) => {
    st.halt ??= why;
    abortController.abort();
  };
  const tooLarge = (what: string) => halt({ type: "agent_error", message: `run too large: more than ${what}`, code: null });
  limits.onTooManyBytes = () => tooLarge(`${MAX_RUN_BYTES / 1024 / 1024} MB streamed`);

  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => halt({ type: "transport_error", message: `the agent sent no event for ${duration(limits.idleMs)}` }),
      Math.min(limits.idleMs, MAX_TIMER_MS),
    );
  };
  const deadlineTimer = setTimeout(
    () => halt({ type: "transport_error", message: `the agent's run passed its ${duration(limits.maxRunMs)} limit` }),
    Math.min(Math.max(0, limits.deadline - Date.now()), MAX_TIMER_MS),
  );
  resetIdle();

  // One chain keeps the log in stream order. It never rejects: the first failed append
  // stops the run, and the rest of its events are skipped.
  let chain: Promise<void> = Promise.resolve();
  const log = (event: AguiEvent) => {
    chain = chain.then(async () => {
      if (st.halt) return;
      try {
        await o.db.begin(async (tx) => {
          await holdClaim(tx, o);
          await appendRunEvent(tx, o, event, data);
        });
      } catch (error) {
        halt(isClaimLost(error) ? { type: "claim_lost" } : { type: "transport_error", message: errorMessage(error) });
      }
    });
  };

  let events = 0;
  const subscriber: AgentSubscriber = {
    onEvent({ event }) {
      if (!live()) return;
      resetIdle();
      if (++events > MAX_RUN_EVENTS) return tooLarge(`${MAX_RUN_EVENTS} events`);
      log(fromAgent(structuredClone(event) as AguiEvent, o));
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
    clearTimeout(idleTimer);
    clearTimeout(deadlineTimer);
    limits.onTooManyBytes = () => {};
  }
  await chain;
  // The set runAgent returns as newMessages, taken here so that a run whose stream
  // broke after its RUN_FINISHED still has them.
  return { ...st, data, newMessages: http.messages.filter((m) => !known.has(m.id)) };
}

async function persistMessages(o: RunLoopOptions, messages: Message[]): Promise<void> {
  const ownCalls = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const tc of m.toolCalls ?? []) if (!isBoardTool(tc.function.name)) ownCalls.add(tc.id);
  }
  const kept: Message[] = [];
  const dropped = new Set<string>();
  for (const m of messages) {
    const s = storable(m, o.agent, ownCalls);
    if (s) kept.push(s);
    else dropped.add(m.role);
  }
  if (dropped.size > 0) {
    const log = o.log ?? ((line: string) => console.log(line));
    log(`${o.agent.name} ${o.threadId}: dropped messages the agent sent as ${[...dropped].join(", ")}`);
  }
  if (kept.length === 0) return;
  await o.db.begin(async (tx) => {
    await holdClaim(tx, o);
    for (const m of kept) await storeMessage(tx, o, m);
  });
}

/** Runs one board tool call as the agent and hands the result back for the next run. */
async function answerCall(
  o: RunLoopOptions,
  http: HttpAgent,
  call: BoardToolCall,
  data: Record<string, unknown>,
): Promise<void> {
  // The board tools write in their own transactions: a run whose claim is gone does none.
  await holdClaim(o.db, o);
  const { content } = await executeBoardTool(o.db, o.auth, call);
  const messageId = newId("msg");
  const message: Message = { id: messageId, role: "tool", toolCallId: call.id, content };
  http.addMessage(message);
  const event: AguiEvent = { type: EventType.TOOL_CALL_RESULT, messageId, toolCallId: call.id, content, role: "tool" };
  await o.db.begin(async (tx) => {
    await holdClaim(tx, o);
    await storeMessage(tx, o, message);
    await appendRunEvent(tx, o, event, data);
  });
}

/**
 * Runs a registered AG-UI agent on a thread: board tools go in as client-side
 * tools, every streamed event is logged as `run.event`, the agent's own messages are
 * stored on the thread, and each run that ends with pending board tool calls has them
 * carried out as the agent before the next run. Every string the agent supplied is
 * scrubbed (NUL and unpaired surrogates become U+FFFD) before it is stored or
 * returned in the outcome. A run is stopped when it goes quiet for idleMs, when the
 * loop passes maxRunMs, when it streams more than MAX_RUN_BYTES or MAX_RUN_EVENTS, and,
 * on a claimed task, as soon as the claim no longer holds the task. Never throws.
 */
export async function runAgentLoop(o: RunLoopOptions): Promise<LoopOutcome> {
  return scrub(await loop(o));
}

async function loop(o: RunLoopOptions): Promise<LoopOutcome> {
  const maxRounds = o.maxRounds ?? MAX_ROUNDS;
  const idleMs = o.idleMs ?? envMs("TEAMKIT_AGENT_IDLE_MS", IDLE_MS_DEFAULT);
  const maxRunMs = o.maxRunMs ?? envMs("TEAMKIT_AGENT_MAX_RUN_MS", MAX_RUN_MS_DEFAULT);
  const limits: Limits = { idleMs, maxRunMs, deadline: Date.now() + maxRunMs, onTooManyBytes: () => {} };
  const http = new HttpAgent({
    url: o.agent.url,
    headers: o.agent.headers,
    threadId: o.threadId,
    initialMessages: o.messages,
    fetch: guardedFetch(o.fetch ?? fetch, limits),
  });
  let delivered = false;
  try {
    for (let round = 1; round <= maxRounds; round++) {
      if (o.signal?.aborted) return { type: "aborted", delivered };
      if (Date.now() >= limits.deadline) {
        return { type: "transport_error", message: `the agent's run passed its ${duration(maxRunMs)} limit`, delivered };
      }
      await holdClaim(o.db, o);
      const r = await runRound(o, http, round, limits);
      if (round === 1 && r.end) delivered = true;
      if (o.signal?.aborted) return { type: "aborted", delivered };
      if (r.halt) return { ...r.halt, delivered };
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
          if (end.pendingToolCallIds.length > MAX_TOOL_CALLS) {
            return { type: "too_many_tool_calls", count: end.pendingToolCallIds.length, delivered };
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
    if (isClaimLost(e)) return { type: "claim_lost", delivered };
    return { type: "transport_error", message: errorMessage(e), delivered };
  }
}
