import Link from "next/link";
import type { Decision } from "@copilotkit/teamkit-protocol";
import { ackText, whenText } from "../lib/coord";
import { Avatar } from "./Avatar";
import board from "./board.module.css";
import styles from "./coord.module.css";

const ACK_AVATARS = 3;

/** The room's decisions, newest first, as Linear list rows that open the decision's thread. */
export function DecisionList({
  decisions,
  room,
  openId,
  query,
}: {
  decisions: Decision[] | null;
  room: string;
  openId: string | null;
  query: string;
}) {
  const now = Date.now();
  const sorted = decisions ? [...decisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : null;
  return (
    <section aria-label="Decisions" className={styles.list}>
      {sorted === null ? (
        <>
          <div className={board.skeleton} />
          <div className={board.skeleton} />
        </>
      ) : sorted.length === 0 ? (
        <p className={board.empty}>{`No decisions in #${room} yet.`}</p>
      ) : (
        sorted.map((d) => {
          const samePoster = d.postedBy.id === d.decidedBy.id;
          return (
            <Link
              key={d.id}
              href={`/t/${encodeURIComponent(d.threadId)}${query}`}
              scroll={false}
              className={styles.row}
              aria-current={d.threadId === openId ? "true" : undefined}
            >
              <Avatar name={d.decidedBy.name} kind={d.decidedBy.kind} size={20} />
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{d.text}</span>
                <span className={styles.rowMeta}>
                  {`Decided by ${d.decidedBy.name}${samePoster ? "" : ` · posted by ${d.postedBy.name}`} · ${whenText(d.createdAt, now)}`}
                </span>
              </span>
              <span className={styles.rowSide}>
                {d.acks.length > 0 ? (
                  <span className={styles.ackAvatars} aria-hidden="true">
                    {d.acks.slice(0, ACK_AVATARS).map((a) => (
                      <Avatar key={a.actor.id} name={a.actor.name} kind={a.actor.kind} size={18} />
                    ))}
                  </span>
                ) : null}
                <span className={styles.ackCount}>{ackText(d.acks.length)}</span>
              </span>
            </Link>
          );
        })
      )}
    </section>
  );
}
