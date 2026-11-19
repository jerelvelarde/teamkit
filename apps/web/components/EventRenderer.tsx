import type { ViewItem } from "../lib/fold";
import styles from "./thread.module.css";

const TONE: Record<string, string> = {
  neutral: styles.toneNeutral,
  info: styles.toneInfo,
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
};

/** Every string from the server or an agent is rendered as React text, never as markup. */
export function EventRenderer({ item }: { item: ViewItem }) {
  switch (item.kind) {
    case "message": {
      const mine = item.role === "user";
      return (
        <div className={`${styles.row} ${mine ? styles.rowMine : ""}`}>
          <div className={`tk-glass ${styles.message}`}>
            <div className={styles.messageHead}>
              <span className={styles.actorName}>{item.actor?.name ?? (mine ? "Person" : "Agent")}</span>
              {item.actor ? <span className="tk-pill">{item.actor.kind}</span> : null}
              {item.streaming ? <span className={styles.streaming}>typing…</span> : null}
            </div>
            <div className={styles.text}>{item.text}</div>
          </div>
        </div>
      );
    }
    case "tool":
      return (
        <details className={styles.tool}>
          <summary className={styles.summary}>
            <span className={styles.mono}>tool {item.name}</span>
            {item.result === null ? <span className={styles.muted}> running</span> : null}
          </summary>
          <div className={styles.label}>args</div>
          <pre className={styles.pre}>{item.args || "(none)"}</pre>
          {item.result !== null ? (
            <>
              <div className={styles.label}>result</div>
              <pre className={styles.pre}>{item.result}</pre>
            </>
          ) : null}
        </details>
      );
    case "reasoning":
      return (
        <details className={styles.tool}>
          <summary className={styles.summary}>reasoning</summary>
          <div className={styles.text}>{item.text}</div>
        </details>
      );
    case "status":
      return (
        <div className={styles.statusRow}>
          <span className={`${styles.statusPill} ${TONE[item.tone] ?? ""}`}>{item.label}</span>
          {item.detail ? <span className={styles.statusDetail}>{item.detail}</span> : null}
        </div>
      );
    case "subagent":
      return (
        <section className={styles.subagent} aria-label={`Subagent ${item.name}`}>
          <div className={styles.subagentHead}>
            <span className={styles.actorName}>{item.name}</span>
            <span className={`${styles.statusPill} ${item.status === "error" ? styles.toneDanger : item.status === "finished" ? styles.toneSuccess : styles.toneInfo}`}>
              {item.status}
            </span>
          </div>
          {item.detail ? <div className={styles.statusDetail}>{item.detail}</div> : null}
          <div className={styles.items}>
            {item.items.map((child) => (
              <EventRenderer key={child.id} item={child} />
            ))}
          </div>
        </section>
      );
  }
}
