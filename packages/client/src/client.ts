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

// STUB (Wave 10)
export function createClient(_opts: ClientOptions): TeamkitClient {
  throw new Error("createClient: not implemented yet");
}
