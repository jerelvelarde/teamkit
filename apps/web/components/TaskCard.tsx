import Link from "next/link";
import type { Task } from "@copilotkit/teamkit-protocol";
import { heldText, namesText, shortDuration } from "../lib/coord";
import { Avatar } from "./Avatar";
import { IconHash, StatusIcon } from "./Icons";
import styles from "./board.module.css";

const BRIEF_MAX = 140;
const NEED_MAX = 48;

export function firstLine(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** "12m left", "2h left", "1h 30m left": how long the holder's lease has to run. */
export function leaseText(expiresAt: string, now: number): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "Lease expired";
  return `${shortDuration(ms)} left`;
}

const NEED_STATE: Record<string, string> = {
  waiting: "waiting",
  ready: "ready",
  claimed: "in progress",
  blocked: "blocked",
  completed: "done",
  failed: "failed",
};

export function TaskCard({
  task,
  now,
  href,
  selected,
  showRoom,
  briefs,
}: {
  task: Task;
  now: number;
  href: string;
  selected: boolean;
  showRoom: boolean;
  briefs: Map<string, string>;
}) {
  const labels = Object.entries(task.labels);
  const holder = task.claim?.actor ?? (task.state === "blocked" ? task.block?.blockedBy : null) ?? null;
  const working = task.state === "claimed" && holder?.kind === "agent";
  const waitingOn = task.state === "waiting" ? task.needs.filter((id) => task.needStates[id] !== "completed") : [];
  const lease = task.state === "claimed" && task.claim ? leaseText(task.claim.leaseExpiresAt, now) : "";
  const held = heldText(task, now);
  const named = task.state === "blocked" && task.block?.approvers && task.block.approvers.length > 0 ? task.block.approvers : null;
  const hasFoot = showRoom || labels.length > 0 || lease !== "" || held !== "";

  return (
    <Link
      href={href}
      className={styles.card}
      data-state={task.state}
      aria-current={selected ? "true" : undefined}
      scroll={false}
    >
      <div className={styles.cardTop}>
        <p className={styles.cardTitle}>{firstLine(task.brief, BRIEF_MAX)}</p>
        {holder ? (
          <span className={styles.holder} title={`${task.state === "claimed" ? "Claimed by" : "Asked by"} ${holder.name}`}>
            <Avatar name={holder.name} kind={holder.kind} size={20} live={working} />
            <span className="tk-visually-hidden">
              {task.state === "claimed" ? "Claimed by" : "Asked by"} {holder.name}
            </span>
          </span>
        ) : null}
      </div>

      {task.state === "blocked" && task.block ? (
        <p className={styles.cardBlock}>
          <span className={styles.cardBlockKind}>
            {task.block.kind === "awaiting_approval" ? "Needs approval" : "Question"}
          </span>
          <span className={styles.cardBlockText}>{firstLine(task.block.question, BRIEF_MAX)}</span>
          {named ? <span className={styles.cardWaitsOn}>Waiting on {namesText(named, "or")}</span> : null}
        </p>
      ) : null}

      {waitingOn.map((id) => {
        const st = task.needStates[id];
        const brief = briefs.get(id);
        return (
          <p key={id} className={styles.cardNeed} data-failed={st === "failed" || undefined}>
            {st ? <StatusIcon state={st} size={12} /> : null}
            <span className={styles.cardNeedText}>
              Needs {brief ? `“${firstLine(brief, NEED_MAX)}”` : `task ${id.slice(-6)}`} ({NEED_STATE[st ?? ""] ?? "unknown"})
            </span>
          </p>
        );
      })}

      {task.state === "failed" ? (
        <p className={styles.cardFailed}>
          <StatusIcon state="failed" size={12} /> Failed
        </p>
      ) : null}

      {hasFoot ? (
        <div className={styles.cardFoot}>
          {showRoom ? (
            <span className={styles.chip}>
              <IconHash size={11} />
              {task.room}
            </span>
          ) : null}
          {labels.map(([k, v]) => (
            <span key={k} className={styles.chip}>
              {k}: {v}
            </span>
          ))}
          <span className={styles.cardFootSpacer} />
          {lease ? <span className={styles.cardMeta}>{lease}</span> : null}
          {held ? <span className={styles.cardMeta}>{held}</span> : null}
        </div>
      ) : null}
    </Link>
  );
}
