import type { ViewItem } from "../lib/fold";
import { Avatar } from "./Avatar";
import { IconChevron, IconThought, IconTool } from "./Icons";
import styles from "./thread.module.css";

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function Time({ at, className }: { at?: string; className: string }) {
  if (!at) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return (
    <time className={className} dateTime={at} title={FULL.format(d)}>
      {TIME.format(d)}
    </time>
  );
}

function TypingDots() {
  return (
    <span className={styles.typing} aria-label="typing">
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * One activity row, drawn the way Slack draws a thread: an avatar gutter, the author's name,
 * then the text. Consecutive messages from one author fold under the first (`grouped`).
 * Every string from the server or an agent is rendered as React text, never as markup.
 */
export function EventRenderer({ item, grouped = false, at }: { item: ViewItem; grouped?: boolean; at?: string }) {
  switch (item.kind) {
    case "message": {
      const person = item.role === "user";
      const name = item.actor?.name ?? (person ? "Person" : "Agent");
      const kind = item.actor?.kind ?? (person ? "person" : "agent");
      return (
        <div className={styles.msg} data-grouped={grouped || undefined}>
          <div className={styles.gutter}>
            {grouped ? <Time at={at} className={styles.hoverTime} /> : <Avatar name={name} kind={kind} size={32} />}
          </div>
          <div className={styles.msgBody}>
            {grouped ? null : (
              <div className={styles.msgHead}>
                <span className={styles.msgName}>{name}</span>
                {kind === "agent" ? <span className={styles.agentBadge}>Agent</span> : null}
                <Time at={at} className={styles.time} />
              </div>
            )}
            <div className={styles.msgText}>
              {item.text}
              {item.streaming ? <TypingDots /> : null}
            </div>
          </div>
        </div>
      );
    }
    case "tool":
      return (
        <details className={styles.fold}>
          <summary className={styles.foldSummary}>
            <span className={styles.gutterIcon}>
              <IconTool size={14} />
            </span>
            <span>
              Used <code className={styles.inlineCode}>{item.name}</code>
              {item.result === null ? <span className={styles.foldMuted}> · running</span> : null}
            </span>
            <IconChevron size={12} className={styles.foldChevron} />
          </summary>
          <div className={styles.foldBody}>
            <div className={styles.foldLabel}>Arguments</div>
            <pre className={styles.pre}>{item.args || "(none)"}</pre>
            {item.result !== null ? (
              <>
                <div className={styles.foldLabel}>Result</div>
                <pre className={styles.pre}>{item.result}</pre>
              </>
            ) : null}
          </div>
        </details>
      );
    case "reasoning":
      return (
        <details className={styles.fold}>
          <summary className={styles.foldSummary}>
            <span className={styles.gutterIcon}>
              <IconThought size={14} />
            </span>
            <span>Thinking</span>
            <IconChevron size={12} className={styles.foldChevron} />
          </summary>
          <div className={styles.foldBody}>
            <div className={styles.msgText}>{item.text}</div>
          </div>
        </details>
      );
    case "status":
      return (
        <div className={styles.sys} data-tone={item.tone}>
          <span className={styles.gutterIcon}>
            <span className={styles.sysDot} />
          </span>
          <span className={styles.sysText}>
            <span className={styles.sysLabel}>{item.label}</span>
            {item.detail ? <span className={styles.sysDetail}> · {item.detail}</span> : null}
          </span>
          <Time at={at} className={styles.sysTime} />
        </div>
      );
    case "subagent":
      return (
        <section className={styles.subagent} aria-label={`Subagent ${item.name}`}>
          <div className={styles.subagentHead}>
            <Avatar name={item.name} kind="agent" size={20} live={item.status === "running"} />
            <span className={styles.msgName}>{item.name}</span>
            <span className={styles.subagentStatus} data-status={item.status}>
              {item.status}
            </span>
          </div>
          {item.detail ? <div className={styles.sysDetail}>{item.detail}</div> : null}
          <div className={styles.subagentItems}>
            {item.items.map((child) => (
              <EventRenderer key={child.id} item={child} />
            ))}
          </div>
        </section>
      );
  }
}
