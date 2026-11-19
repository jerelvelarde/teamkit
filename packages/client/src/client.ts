import type {
  BlockKind,
  BoardEvent,
  Claim,
  EventQuery,
  PlanItem,
  RoomSummary,
  RoomView,
  Task,
  TaskState,
  ThreadView,
  Whoami,
} from "@copilotkit/teamkit-protocol";
import { parseSse } from "./sse.js";

export interface ClientOptions {
  url: string;
  /** Omit for cookie-session mode: no Authorization header is sent and the browser's same-origin cookie carries the session. */
  token?: string;
  fetch?: typeof fetch;
  /**
   * How long one request may take, response body included, before it throws a
   * TeamkitError with code `timeout` (status 0). Default 15 s; 0 turns it off.
   * A claimNext long poll gets its waitMs on top; stream() never times out.
   */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export class TeamkitError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "TeamkitError";
    this.code = code;
    this.status = status;
  }
}

export interface TeamkitClient {
  whoami(): Promise<Whoami>;
  rooms(): Promise<RoomSummary[]>;
  room(name: string, opts?: { after?: string }): Promise<RoomView>;
  thread(id: string): Promise<ThreadView>;
  post(room: string, text: string): Promise<{ threadId: string }>;
  reply(threadId: string, text: string): Promise<void>;
  label(threadId: string, key: string, value: string): Promise<void>;
  tasks(q?: { room?: string; state?: TaskState | "all"; labels?: Record<string, string> }): Promise<Task[]>;
  createTask(input: {
    room: string;
    brief: string;
    labels?: Record<string, string>;
    needs?: string[];
    target?: string;
  }): Promise<Task>;
  createPlan(room: string, plan: PlanItem[]): Promise<Record<string, Task>>;
  claim(taskId: string): Promise<Claim>;
  claimNext(
    room: string,
    opts?: { labels?: Record<string, string>; waitMs?: number; signal?: AbortSignal },
  ): Promise<Claim | null>;
  renew(taskId: string, claimId: string): Promise<{ leaseExpiresAt: string }>;
  release(taskId: string, claimId: string): Promise<Task>;
  complete(taskId: string, claimId: string, result?: string | null): Promise<Task>;
  fail(taskId: string, claimId: string, reason: string): Promise<Task>;
  block(
    taskId: string,
    claimId: string,
    input: { question: string; kind?: BlockKind; options?: string[] },
  ): Promise<Task>;
  answer(taskId: string, input: { text?: string; choice?: string }): Promise<Task>;
  events(q?: EventQuery): Promise<{ events: BoardEvent[]; cursor: string }>;
  stream(q: EventQuery, opts?: { signal?: AbortSignal }): AsyncIterable<BoardEvent>;
}

function eventParams(q: EventQuery | undefined): URLSearchParams {
  const params = new URLSearchParams();
  if (q?.after !== undefined) params.set("after", q.after);
  if (q?.room !== undefined) params.set("room", q.room);
  if (q?.thread !== undefined) params.set("thread", q.thread);
  for (const k of q?.kinds ?? []) params.append("kind", k);
  if (q?.limit !== undefined) params.set("limit", String(q.limit));
  return params;
}

function withQuery(path: string, params: URLSearchParams): string {
  const s = params.toString();
  return s === "" ? path : `${path}?${s}`;
}

export async function toError(res: Response): Promise<TeamkitError> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === "string") {
      return new TeamkitError(body.error.code, res.status, String(body.error.message ?? ""));
    }
  } catch {
    // fall through to http_error
  }
  return new TeamkitError("http_error", res.status, text);
}

export function createClient(opts: ClientOptions): TeamkitClient {
  const base = `${opts.url.replace(/\/+$/, "")}/v1`;
  const doFetch = opts.fetch ?? fetch;
  const enc = encodeURIComponent;

  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * Sends one request and reads its response with `read`, under the caller's
   * signal and the request timeout together. A timeout throws TeamkitError
   * `timeout`; a caller's abort throws as fetch does.
   */
  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    init: { signal?: AbortSignal; accept?: string; timeoutMs?: number },
    read: (res: Response) => Promise<T>,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (init.accept !== undefined) headers.accept = init.accept;
    if (body !== undefined) headers["content-type"] = "application/json";
    const ms = init.timeoutMs ?? defaultTimeoutMs;
    const timer = ms > 0 && Number.isFinite(ms) ? AbortSignal.timeout(ms) : undefined;
    const signals = [init.signal, timer].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw await toError(res);
      return await read(res);
    } catch (e) {
      // An error body cut off by the timeout reads as an http_error; any server code is kept.
      const serverCode = e instanceof TeamkitError && e.code !== "http_error";
      if (timer?.aborted && !init.signal?.aborted && !serverCode) {
        throw new TeamkitError("timeout", 0, `${method} ${path} got no response within ${ms} ms`);
      }
      throw e;
    }
  }

  function json<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return request(method, path, body, {}, async (res) => {
      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new TeamkitError("http_error", res.status, text);
      }
    });
  }

  return {
    whoami: () => json("GET", "/whoami"),
    rooms: async () => (await json<{ rooms: RoomSummary[] }>("GET", "/rooms")).rooms,
    room: (name, o) => {
      const params = new URLSearchParams({ name });
      if (o?.after !== undefined) params.set("after", o.after);
      return json("GET", withQuery("/room", params));
    },
    thread: (id) => json("GET", `/threads/${enc(id)}`),
    post: (room, text) => json("POST", "/posts", { room, text }),
    reply: async (threadId, text) => {
      await json("POST", `/threads/${enc(threadId)}/replies`, { text });
    },
    label: async (threadId, key, value) => {
      await json("POST", `/threads/${enc(threadId)}/labels`, { key, value });
    },
    tasks: async (q) => {
      const params = new URLSearchParams();
      if (q?.room !== undefined) params.set("room", q.room);
      if (q?.state !== undefined) params.set("state", q.state);
      for (const [k, v] of Object.entries(q?.labels ?? {})) params.append("label", `${k}=${v}`);
      return (await json<{ tasks: Task[] }>("GET", withQuery("/tasks", params))).tasks;
    },
    createTask: async (input) => (await json<{ task: Task }>("POST", "/tasks", input)).task,
    createPlan: async (room, plan) =>
      (await json<{ tasks: Record<string, Task> }>("POST", "/tasks", { room, plan })).tasks,
    claim: (taskId) => json("POST", `/tasks/${enc(taskId)}/claim`, {}),
    claimNext: (room, o) =>
      request(
        "POST",
        "/tasks/claim-next",
        { room, labels: o?.labels, waitMs: o?.waitMs },
        // The server holds a long poll up to waitMs before it answers.
        { signal: o?.signal, timeoutMs: defaultTimeoutMs > 0 ? defaultTimeoutMs + (o?.waitMs ?? 0) : 0 },
        async (res) => (res.status === 204 ? null : ((await res.json()) as Claim)),
      ),
    renew: (taskId, claimId) => json("POST", `/tasks/${enc(taskId)}/renew`, { claimId }),
    release: async (taskId, claimId) =>
      (await json<{ task: Task }>("POST", `/tasks/${enc(taskId)}/release`, { claimId })).task,
    complete: async (taskId, claimId, result) =>
      (await json<{ task: Task }>("POST", `/tasks/${enc(taskId)}/complete`, {
        claimId,
        ...(result != null ? { result } : {}),
      })).task,
    fail: async (taskId, claimId, reason) =>
      (await json<{ task: Task }>("POST", `/tasks/${enc(taskId)}/fail`, { claimId, reason })).task,
    block: async (taskId, claimId, input) =>
      (await json<{ task: Task }>("POST", `/tasks/${enc(taskId)}/block`, { claimId, ...input })).task,
    answer: async (taskId, input) =>
      (await json<{ task: Task }>("POST", `/tasks/${enc(taskId)}/answer`, input)).task,
    events: (q) => json("GET", withQuery("/events", eventParams(q))),
    stream: (q, o) => streamEvents(q, o?.signal),
  };

  /**
   * The server ends a stream at its lifetime cap; this reopens it after the last id
   * seen (a live tail's first, id-only frame gives one before any event), so the
   * caller sees one unbroken stream. A revoked token makes the reopen throw.
   */
  async function* streamEvents(q: EventQuery, signal?: AbortSignal): AsyncGenerator<BoardEvent> {
    let after = q.after;
    for (;;) {
      if (signal?.aborted) return;
      let res: Response;
      try {
        res = await request(
          "GET",
          withQuery("/events/stream", eventParams({ ...q, after })),
          undefined,
          { signal, accept: "text/event-stream", timeoutMs: 0 },
          async (r) => r,
        );
      } catch (err) {
        if (signal?.aborted) return;
        throw err;
      }
      if (res.body === null) return;
      for await (const frame of parseSse(res.body, signal, (id) => (after = id))) {
        if (frame.event === "board") yield JSON.parse(frame.data) as BoardEvent;
      }
      if (signal?.aborted || after === undefined) return;
    }
  }
}
