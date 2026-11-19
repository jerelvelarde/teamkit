/** @jsxImportSource @copilotkit/channels */
import { Actions, Button, Context, Field, Fields, Header, Message, Section } from "@copilotkit/channels";
import type { TaskState } from "@copilotkit/teamkit-protocol";

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

/**
 * Escape text that came from an agent or a person before it goes into a Slack
 * mrkdwn field. Slack's own rule: `&`, `<` and `>` become entities, so
 * `<!channel>`, `<@U123>` and `<http://x|y>` render as plain text. The Markdown
 * link form `[a](url)` would be turned into `<url|a>` by the renderer, so the
 * `](` pair is split with a zero-width space.
 */
export function escapeMrkdwn(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\]\(/g, "]​(");
}

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
}

export function BlockedCard({ task, interruptId, kind, question, options, askedBy }: BlockedCardProps) {
  const title = kind === "awaiting_approval" ? "Needs approval" : "Needs input";
  return (
    <Message fallbackText={`${title}: ${escapeMrkdwn(clip(question, 200))}`}>
      <Header>{title}</Header>
      <Section>{escapeMrkdwn(clip(question, 2000))}</Section>
      <Context>{`Asked by ${escapeMrkdwn(askedBy ?? "an agent")} · ${escapeMrkdwn(task.room)}`}</Context>
      {options.length === 0 ? (
        <Context>Reply in this thread to answer.</Context>
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
