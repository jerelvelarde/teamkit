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
  token: string;
  fetch?: typeof fetch;
}

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

async function toError(res: Response): Promise<TeamkitError> {
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

  async function send(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    init: { signal?: AbortSignal; accept?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` };
    if (init.accept !== undefined) headers.accept = init.accept;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: init.signal,
    });
    if (!res.ok) throw await toError(res);
    return res;
  }

  async function json<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await send(method, path, body);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TeamkitError("http_error", res.status, text);
    }
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
    claimNext: async (room, o) => {
      const res = await send(
        "POST",
        "/tasks/claim-next",
        { room, labels: o?.labels, waitMs: o?.waitMs },
        { signal: o?.signal },
      );
      if (res.status === 204) return null;
      return (await res.json()) as Claim;
    },
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

  async function* streamEvents(q: EventQuery, signal?: AbortSignal): AsyncGenerator<BoardEvent> {
    if (signal?.aborted) return;
    let res: Response;
    try {
      res = await send("GET", withQuery("/events/stream", eventParams(q)), undefined, {
        signal,
        accept: "text/event-stream",
      });
    } catch (err) {
      if (signal?.aborted) return;
      throw err;
    }
    if (res.body === null) return;
    for await (const frame of parseSse(res.body, signal)) {
      if (frame.event === "board") yield JSON.parse(frame.data) as BoardEvent;
    }
  }
}
