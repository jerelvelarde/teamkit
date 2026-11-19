import type { BaseEvent, Message } from "@ag-ui/core";

export type TaskState = "waiting" | "ready" | "claimed" | "blocked" | "completed" | "failed";
export type BlockKind = "needs_input" | "awaiting_approval";
export type Permission = "read" | "post" | "claim" | "create";
export type EventKind =
  | "thread.created"
  | "message.posted"
  | "label.set"
  | "task.created"
  | "task.claimed"
  | "task.released"
  | "task.lease_expired"
  | "task.blocked"
  | "task.answered"
  | "task.ready"
  | "task.completed"
  | "task.failed"
  | "run.event"
  | "task.handed_off"
  | "decision.posted"
  | "decision.acked"
  | "rollcall.started"
  | "rollcall.answered"
  | "change.logged"
  | "change.updated"
  | "alert.raised"
  | "alert.confirmed"
  | "alert.resolved";

export const TASK_STATES = ["waiting", "ready", "claimed", "blocked", "completed", "failed"] as const satisfies readonly TaskState[];
export const BLOCK_KINDS = ["needs_input", "awaiting_approval"] as const satisfies readonly BlockKind[];
export const PERMISSIONS = ["read", "post", "claim", "create"] as const satisfies readonly Permission[];
export const EVENT_KINDS = [
  "thread.created",
  "message.posted",
  "label.set",
  "task.created",
  "task.claimed",
  "task.released",
  "task.lease_expired",
  "task.blocked",
  "task.answered",
  "task.ready",
  "task.completed",
  "task.failed",
  "run.event",
  "task.handed_off",
  "decision.posted",
  "decision.acked",
  "rollcall.started",
  "rollcall.answered",
  "change.logged",
  "change.updated",
  "alert.raised",
  "alert.confirmed",
  "alert.resolved",
] as const satisfies readonly EventKind[];

export const MAX_TEXT_LENGTH = 32_000;
export const MAX_BODY_BYTES = 1_048_576;
export const LEASE_MS_DEFAULT = 300_000;
export const RENEW_EVERY_MS = 60_000;
export const CLAIM_NEXT_MAX_WAIT_MS = 25_000;

export type AguiEvent = BaseEvent & Record<string, unknown>;
export type AguiMessage = Message;

export interface ActorRef {
  id: string;
  name: string;
  kind: "agent" | "person";
}

export interface TaskClaim {
  id: string;
  actor: ActorRef;
  leaseExpiresAt: string;
}

export interface TaskBlock {
  interruptId: string;
  kind: BlockKind;
  question: string;
  options: string[] | null;
  blockedBy: ActorRef;
  /** People named to answer; null means the room's approvers (an approval) or anyone allowed (a question). */
  approvers: string[] | null;
}

export interface PendingResume {
  interruptId: string;
  status: "resolved";
  payload: { text?: string; choice?: string };
}

export interface Task {
  id: string;
  room: string;
  state: TaskState;
  brief: string;
  labels: Record<string, string>;
  needs: string[];
  needStates: Record<string, TaskState>;
  target: string | null;
  claim: TaskClaim | null;
  block: TaskBlock | null;
  pendingResume: PendingResume[] | null;
  /** A hold: the task is kept for this actor until reservedUntil (a handoff, or an answered ask). */
  reservedFor: ActorRef | null;
  reservedUntil: string | null;
  attempts: number;
  result: string | null;
  createdBy: ActorRef;
  createdAt: string;
  updatedAt: string;
}

export interface Claim {
  task: Task;
  claimId: string;
  leaseExpiresAt: string;
}

export interface PlanItem {
  key: string;
  text: string;
  labels?: Record<string, string>;
  needs?: ({ key: string } | { id: string })[];
  target?: string;
}

export interface BoardEvent {
  /** Decimal string of a bigint. */
  cursor: string;
  kind: EventKind;
  room: string;
  threadId: string | null;
  actor: ActorRef | null;
  agui: AguiEvent[];
  data: Record<string, unknown>;
  createdAt: string;
}

export interface EventQuery {
  after?: string;
  room?: string;
  thread?: string;
  kinds?: EventKind[];
  limit?: number;
}

export interface Whoami {
  actor: ActorRef;
  scope: "agent" | "admin" | null;
  role: "admin" | "member" | null;
}

export interface RoomSummary {
  name: string;
  createdAt: string;
}

export interface RoomInfo extends RoomSummary {
  agent: string | null;
  approvers: string[] | null;
  slackChannel: string | null;
  slackAnnounce: "blocked" | "all" | "none";
  /** How long a handoff or an answered ask is held for one actor, in minutes. */
  reservationMinutes: number;
}

export interface ThreadInfo {
  id: string;
  room: string;
  isTask: boolean;
  labels: Record<string, string>;
  createdBy: ActorRef;
  createdAt: string;
}

export interface ThreadSummary extends ThreadInfo {
  state: TaskState | null;
  brief: string | null;
}

export interface ThreadView {
  thread: ThreadInfo;
  task: Task | null;
  messages: AguiMessage[];
  cursor: string;
}

export interface RoomView {
  room: RoomInfo;
  threads: ThreadSummary[];
  cursor: string;
}

export type Role = "admin" | "member";
export interface GrantSpec { room: string; perms: Permission[] }
export interface PersonInfo { actor: ActorRef; role: Role; createdAt: string; lastSignInAt: string | null }
export interface Invite { person: ActorRef; role: Role; link: string }
export interface TokenInfo { id: string; actorId: string; actorName: string; scope: "agent" | "admin"; createdAt: string; revokedAt: string | null }
export interface CreatedToken { actor: ActorRef; token: string; tokenId: string }
export interface RoomSettingsInput { agent?: string | null; approvers?: string[] | null; slackChannel?: string | null; slackAnnounce?: "blocked" | "all" | "none"; reservationMinutes?: number }
export interface DeviceStart { deviceCode: string; userCode: string; verifyUrl: string; expiresAt: string; intervalMs: number }
export type DevicePoll = { status: "pending" } | { status: "expired" } | { status: "approved"; token: string; actor: ActorRef };
export interface AgentRegistration { name: string; url: string; rooms: string[]; headers?: Record<string, string> }
export interface AgentInfo { name: string; actor: ActorRef; url: string; rooms: string[]; headerNames: string[]; enabled: boolean; createdAt: string }
export type TriggerAction = { type: "webhook"; url: string } | { type: "agent"; agent: string };
export interface TriggerInput { name: string; room: string; kinds: EventKind[]; labels?: Record<string, string>; webhook?: string; agent?: string }
export interface TriggerInfo { id: string; name: string; room: string; kinds: EventKind[]; labels: Record<string, string> | null; action: TriggerAction; cursor: string; enabled: boolean; createdAt: string }
export interface CreatedTrigger { trigger: TriggerInfo; secret: string | null }

/** How a device code signs in: as an admin login, or as the approving person's own agent. */
export type DeviceMode = "admin" | "agent";
export const DEVICE_MODES = ["admin", "agent"] as const satisfies readonly DeviceMode[];

/** A team join link as an admin sees it. The secret link itself is shown only once, at creation. */
export interface JoinLink {
  id: string;
  createdAt: string;
  expiresAt: string | null;
  domains: string[] | null;
  revokedAt: string | null;
  uses: number;
}
export interface CreatedJoinLink extends JoinLink {
  link: string;
}
export interface JoinLinkInput {
  expiresInDays?: number;
  domains?: string[];
}

export type ChangeStatus = "active" | "done" | "restored";
export const CHANGE_STATUSES = ["active", "done", "restored"] as const satisfies readonly ChangeStatus[];
export type AlertLevel = "suspected" | "confirmed";
export const ALERT_LEVELS = ["suspected", "confirmed"] as const satisfies readonly AlertLevel[];
export const RESERVATION_MINUTES_DEFAULT = 30;
export const RESERVATION_MINUTES_MAX = 1440;
/** How often a running agent tells the server it is on. */
export const HEARTBEAT_EVERY_MS = 30_000;
/** An agent counts as on when one of its sessions was seen within this long. */
export const PRESENCE_ON_MS = 90_000;
/** A roll call shows as waiting for this long. */
export const ROLLCALL_OPEN_MS = 3_600_000;
export const MAX_APPROVERS = 10;

export interface DecisionAck { actor: ActorRef; at: string }
/** A decision a person made, posted for the room's agents to acknowledge. It grants no authority. */
export interface Decision { id: string; room: string; threadId: string; text: string; decidedBy: ActorRef; postedBy: ActorRef; createdAt: string; acks: DecisionAck[] }
export interface RollCallAnswer { actor: ActorRef; status: string; at: string }
export interface RollCall { id: string; room: string; threadId: string; askedBy: ActorRef; createdAt: string; answers: RollCallAnswer[] }
export interface PresenceSession { tokenId: string; watching: string[]; status: string | null; lastSeenAt: string }
export interface Presence { actor: ActorRef; owner: ActorRef | null; sessions: PresenceSession[] }
/** A change someone made, with how to undo it. Names and short identifiers only, never secret values. */
export interface ChangeEntry { id: string; room: string; threadId: string | null; what: string; where: string; at: string; person: ActorRef; agent: ActorRef | null; undo: string; undoWhen: string | null; status: ChangeStatus; createdAt: string; updatedAt: string }
export interface ChangeInput { room: string; threadId?: string; what: string; where: string; at?: string; undo: string; undoWhen?: string }
export interface Alert { id: string; room: string; threadId: string; text: string; level: AlertLevel; raisedBy: ActorRef; confirmedBy: ActorRef | null; source: ActorRef | null; resolvedBy: ActorRef | null; resolvedSource: ActorRef | null; resolvedAt: string | null; createdAt: string }
/** What is waiting on the caller. */
export interface Pending { handoffs: Task[]; answered: Task[]; decisions: Decision[]; rollCalls: RollCall[]; asks: Task[] }
