/** @jsxImportSource @copilotkit/channels */
import { Actions, Button, Context, Field, Fields, Header, Message, Section } from "@copilotkit/channels";
import type { ActorRef, Alert, Decision, TaskState } from "@copilotkit/teamkit-protocol";

export const ANSWER_ACTION_ID = "teamkit.answer";

export interface AnswerValue {
  taskId: string;
  interruptId: string;
  choice: string;
}

export interface CardTask {
  id: string;
  room: string;
  state: TaskState;
  brief: string;
  /** `${publicUrl}/t/${id}` */
  url: string;
}

export { escapeMrkdwn } from "./escape.js";
import { escapeMrkdwn } from "./escape.js";

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function briefExcerpt(brief: string): string {
  return clip(brief.split("\n").slice(0, 3).join("\n"), 500);
}

function OpenLink({ url }: { url: string }) {
  return (
    <Actions>
      <Button url={url}>Open on the board</Button>
    </Actions>
  );
}

export function TaskCard({ task }: { task: CardTask }) {
  return (
    <Message fallbackText={`Task in ${escapeMrkdwn(task.room)}`}>
      <Header>{`Task in ${task.room}`}</Header>
      <Section>{escapeMrkdwn(briefExcerpt(task.brief))}</Section>
      <Fields>
        <Field label="State">{escapeMrkdwn(task.state)}</Field>
        <Field label="Task id">{escapeMrkdwn(task.id)}</Field>
      </Fields>
      <OpenLink url={task.url} />
    </Message>
  );
}

export interface BlockedCardProps {
  task: CardTask;
  interruptId: string;
  kind: "awaiting_approval" | "awaiting_input";
  question: string;
  options: string[];
  askedBy?: string | null;
  /** Who the ask waits on (see coordination.ts waitsOn); null means anyone who may answer. Absent: not shown. */
  waitsOn?: string[] | null;
  /** Person name to linked Slack user id, for mentioning the people an ask waits on. */
  mentions?: Record<string, string>;
}

const SLACK_USER_ID = /^[UW][A-Z0-9]{2,20}$/;

/** A live mention when the name maps to a well-formed Slack user id, else the escaped name. */
function mentionOf(name: string, mentions: Record<string, string> | undefined): string {
  const id = mentions?.[name];
  return id !== undefined && SLACK_USER_ID.test(id) ? `<@${id}>` : escapeMrkdwn(name);
}

export function BlockedCard({ task, interruptId, kind, question, options, askedBy, waitsOn, mentions }: BlockedCardProps) {
  const title = kind === "awaiting_approval" ? "Needs approval" : "Needs input";
  const who = waitsOn && waitsOn.length > 0 ? waitsOn.map((n) => mentionOf(n, mentions)).join(", ") : null;
  const fallback = who
    ? `${title} from ${who}: ${escapeMrkdwn(clip(question, 200))}`
    : `${title}: ${escapeMrkdwn(clip(question, 200))}`;
  return (
    <Message fallbackText={fallback}>
      <Header>{title}</Header>
      <Section>{escapeMrkdwn(clip(question, 2000))}</Section>
      <Context>{`Asked by ${escapeMrkdwn(askedBy ?? "an agent")} · ${escapeMrkdwn(task.room)}`}</Context>
      {waitsOn === undefined ? null : (
        <Context>{who ? `Waiting on ${who}` : `Anyone in ${escapeMrkdwn(task.room)} can answer`}</Context>
      )}
      {options.length === 0 ? (
        <Context>
          {kind === "awaiting_approval"
            ? "Answer this approval on the board."
            : "Reply in this thread to answer."}
        </Context>
      ) : (
        options.map((option, i) => (
          <Actions>
            <Button
              value={{ taskId: task.id, interruptId, choice: option } satisfies AnswerValue}
              style={i === 0 ? "primary" : undefined}
            >
              {option}
            </Button>
          </Actions>
        ))
      )}
      <OpenLink url={task.url} />
    </Message>
  );
}

export interface OutcomeCardProps {
  task: CardTask;
  outcome: "completed" | "failed";
  text: string;
}

export function OutcomeCard({ task, outcome, text }: OutcomeCardProps) {
  const title = outcome === "completed" ? "Completed" : "Failed";
  const body = text.trim() ? escapeMrkdwn(clip(text, 500)) : "(no result)";
  return (
    <Message fallbackText={`${title}: ${body.replace(/\s+/g, " ").slice(0, 120)}`}>
      <Header>{title}</Header>
      <Section>{body}</Section>
      <OpenLink url={task.url} />
    </Message>
  );
}

/** "by", or "by for source" when someone acted for another (an agent for its owner). */
function forWhom(by: ActorRef, source: ActorRef | null): string {
  return source && source.id !== by.id ? `${escapeMrkdwn(by.name)} for ${escapeMrkdwn(source.name)}` : escapeMrkdwn(by.name);
}

/** A decision posted at the top level. It records what a person decided; it grants nothing. */
export function DecisionCard({ decision: d }: { decision: Decision }) {
  const posted = d.postedBy.id === d.decidedBy.id ? "" : ` · posted by ${escapeMrkdwn(d.postedBy.name)}`;
  const acks = d.acks.length === 0 ? "No acknowledgements yet" : `Acknowledged by ${d.acks.map((a) => escapeMrkdwn(a.actor.name)).join(", ")}`;
  return (
    <Message fallbackText={`Decision in ${escapeMrkdwn(d.room)}: ${escapeMrkdwn(clip(d.text, 200))}`}>
      <Header>Decision</Header>
      <Section>{escapeMrkdwn(clip(d.text, 2000))}</Section>
      <Context>{`Decided by ${escapeMrkdwn(d.decidedBy.name)}${posted} · ${escapeMrkdwn(d.room)}`}</Context>
      <Context>{acks}</Context>
    </Message>
  );
}

/**
 * An alert posted at the top level. It is loud (one `<!here>`) only while confirmed and open; a
 * suspected alert is plain, and a resolved one says who resolved it and pings no one.
 */
export function AlertCard({ alert: a }: { alert: Alert }) {
  const resolved = a.resolvedBy !== null;
  const loud = a.level === "confirmed" && !resolved;
  const title = resolved ? "Resolved alert" : a.level === "confirmed" ? "Alert" : "Suspected alert";
  const text = escapeMrkdwn(clip(a.text, 2000));
  const context = [
    `Raised by ${escapeMrkdwn(a.raisedBy.name)}`,
    escapeMrkdwn(a.room),
    ...(a.confirmedBy ? [`confirmed by ${forWhom(a.confirmedBy, a.source)}`] : []),
    ...(a.resolvedBy ? [`Resolved by ${forWhom(a.resolvedBy, a.resolvedSource)}`] : []),
  ].join(" · ");
  const fallback = `${loud ? "<!here> " : ""}${title} in ${escapeMrkdwn(a.room)}: ${escapeMrkdwn(clip(a.text, 200))}`;
  return (
    <Message fallbackText={fallback}>
      <Header>{title}</Header>
      <Section>{loud ? `<!here> ${text}` : text}</Section>
      <Context>{context}</Context>
    </Message>
  );
}

/** What the pinned status message shows for one room. */
export interface RoomStatus {
  room: string;
  roomUrl: string;
  agentsOn: { name: string; sessions: number }[];
  working: { taskId: string; brief: string; by: string; url: string }[];
  asks: { taskId: string; question: string; waitsOn: string[] | null; url: string }[];
  /** Claimed tasks beyond those listed in `working`. */
  moreWorking: number;
  /** Asks beyond those listed in `asks`. */
  moreAsks: number;
  counts: { ready: number; waiting: number; claimed: number; blocked: number };
}

const AGENTS_SHOWN = 20;

/** A short link label: the first line, clipped to 80 characters, escaped. */
function linkLabel(text: string): string {
  return escapeMrkdwn(clip(text.split("\n", 1)[0] ?? "", 80));
}

/** The pinned status message: agents on, the work in hand, asks waiting on people, open task counts. */
export function StatusCard({ status: s, changedAt }: { status: RoomStatus; changedAt: number }) {
  const shown = s.agentsOn.slice(0, AGENTS_SHOWN);
  const extraAgents = s.agentsOn.length - shown.length;
  const agents =
    shown.length === 0
      ? "**Agents on:** none right now"
      : `**Agents on:** ${shown.map((a) => (a.sessions > 1 ? `${escapeMrkdwn(a.name)} (${a.sessions} sessions)` : escapeMrkdwn(a.name))).join(", ")}${extraAgents > 0 ? ` and ${extraAgents} more` : ""}`;
  const more = (n: number) => (n > 0 ? [`• and ${n} more on the board`] : []);
  const workLines = [...s.working.map((w) => `• ${escapeMrkdwn(w.by)}: <${w.url}|${linkLabel(w.brief)}>`), ...more(s.moreWorking)];
  const askLines = [
    ...s.asks.map((a) => `• ${a.waitsOn && a.waitsOn.length > 0 ? a.waitsOn.map(escapeMrkdwn).join(", ") : "anyone"}: <${a.url}|${linkLabel(a.question)}>`),
    ...more(s.moreAsks),
  ];
  const c = s.counts;
  const seconds = Math.floor(changedAt / 1000);
  return (
    <Message fallbackText={`Status for ${escapeMrkdwn(s.room)}`}>
      <Header>{`Status · ${s.room}`}</Header>
      <Section>{agents}</Section>
      <Section>{workLines.length === 0 ? "**Working:** nothing claimed" : `**Working:**\n${workLines.join("\n")}`}</Section>
      <Section>{askLines.length === 0 ? "**Waiting on people:** nothing" : `**Waiting on people:**\n${askLines.join("\n")}`}</Section>
      <Context>{`Open tasks: ${c.ready} ready · ${c.waiting} waiting on other tasks · ${c.claimed} working · ${c.blocked} waiting on a person`}</Context>
      <Context>{`Last change <!date^${seconds}^{date_short_pretty} {time}|${new Date(changedAt).toISOString()}> · <${s.roomUrl}|Open the board>`}</Context>
    </Message>
  );
}
