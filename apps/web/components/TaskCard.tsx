import type { Task } from "@copilotkit/teamkit-protocol";
import styles from "./board.module.css";

const BRIEF_MAX = 120;

function firstLine(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function shortId(id: string): string {
  return id.slice(-6);
}

function leaseText(expiresAt: string, now: number): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "lease expired";
  return `${Math.max(1, Math.ceil(ms / 60_000))}m left`;
}

export function TaskCard({ task, now }: { task: Task; now: number }) {
  const labels = Object.entries(task.labels);
  const blocked = task.state === "blocked";
  const failed = task.state === "failed";

  const needsLine = task.needs.length > 0 && task.state === "waiting";

  return (
    <a
      href={`/t/${encodeURIComponent(task.id)}`}
      className={`${styles.card} ${blocked ? styles.cardBlocked : ""}`}
      data-state={task.state}
    >
      <p className={styles.brief}>{firstLine(task.brief, BRIEF_MAX)}</p>
      <div className={styles.pills}>
        <span className="tk-pill">{task.room}</span>
        {labels.map(([k, v]) => (
          <span key={k} className="tk-pill">
            {k}={v}
          </span>
        ))}
      </div>

      {task.state === "claimed" && task.claim ? (
        <p className={styles.status}>
          claimed by <strong>{task.claim.actor.name}</strong>
          {" · "}
          {leaseText(task.claim.leaseExpiresAt, now)}
        </p>
      ) : null}

      {needsLine
        ? task.needs.map((id) => {
            const st = task.needStates[id];
            return (
              <p key={id} className={`${styles.status} ${st === "failed" ? styles.danger : ""}`}>
                needs {shortId(id)} ({st ?? "unknown"})
              </p>
            );
          })
        : null}

      {blocked && task.block ? (
        <div className={styles.blockedInfo}>
          <span className={styles.blockedKind}>
            {task.block.kind === "awaiting_approval" ? "approval" : "question"}
          </span>
          <p className={styles.status}>{firstLine(task.block.question, BRIEF_MAX)}</p>
        </div>
      ) : null}

      {task.state === "completed" ? <p className={styles.status}>completed</p> : null}
      {failed ? <p className={`${styles.status} ${styles.danger}`}>failed</p> : null}
    </a>
  );
}
