import Link from "next/link";
import type { ChangeEntry } from "@copilotkit/teamkit-protocol";
import { CHANGE_STATUS_LABEL, sortChanges, whenText } from "../lib/coord";
import board from "./board.module.css";
import styles from "./coord.module.css";

/** One change: what changed, where, how to undo it, who logged it, and its status. */
function ChangeRow({ c, now }: { c: ChangeEntry; now: number }) {
  const who = c.agent ? `${c.person.name} via ${c.agent.name}` : c.person.name;
  return (
    <>
      <span className={styles.dotColumn}>
        <span className="tk-status-dot" data-status={c.status} aria-hidden="true" />
      </span>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{c.what}</span>
        <span className={styles.rowMeta}>{`${c.where} · Undo: ${c.undo}${c.undoWhen ? ` (${c.undoWhen})` : ""}`}</span>
        <span className={styles.rowMeta}>{`${who} · ${whenText(c.at, now)}`}</span>
      </span>
      <span className={styles.rowStatus}>{CHANGE_STATUS_LABEL[c.status]}</span>
    </>
  );
}

/**
 * The room's change log: active changes first, then newest first. Read-only: the board shows a
 * change's status, it does not set it. A change that belongs to no task shows only here.
 */
export function ChangeLog({
  changes,
  room,
  openId,
  query,
}: {
  changes: ChangeEntry[] | null;
  room: string;
  openId: string | null;
  query: string;
}) {
  const now = Date.now();
  return (
    <section aria-label="Changes" className={styles.list}>
      {changes === null ? (
        <>
          <div className={board.skeleton} />
          <div className={board.skeleton} />
        </>
      ) : changes.length === 0 ? (
        <p className={board.empty}>{`No changes logged in #${room} yet.`}</p>
      ) : (
        sortChanges(changes).map((c) =>
          c.threadId ? (
            <Link
              key={c.id}
              href={`/t/${encodeURIComponent(c.threadId)}${query}`}
              scroll={false}
              className={styles.row}
              aria-current={c.threadId === openId ? "true" : undefined}
            >
              <ChangeRow c={c} now={now} />
            </Link>
          ) : (
            <div key={c.id} className={styles.row} data-static="true">
              <ChangeRow c={c} now={now} />
            </div>
          ),
        )
      )}
    </section>
  );
}
