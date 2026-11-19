"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ActorRef, Alert } from "@copilotkit/teamkit-protocol";
import { api } from "../lib/api";
import { bannerAlerts, whenText } from "../lib/coord";
import { IconAlert } from "./Icons";
import styles from "./coord.module.css";

/** How long a row the viewer just resolved stays up, saying who resolved it. */
const RESOLVED_HOLD_MS = 3000;

/** "Resolved by sam", or "Resolved by ben-agent for ben" when an agent resolved it for its owner. */
function resolvedText(by: ActorRef | null, source: ActorRef | null): string {
  if (!by) return "Resolved";
  return source && source.id !== by.id ? `Resolved by ${by.name} for ${source.name}` : `Resolved by ${by.name}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong. Try again.";
}

function AlertRow({ alert, query, now, onChanged, onResolved }: {
  alert: Alert;
  query: string;
  now: number;
  onChanged(): void;
  onResolved(a: Alert): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolved = alert.resolvedAt !== null;
  const confirmed = alert.level === "confirmed";

  async function act(run: () => Promise<Alert>, after?: (a: Alert) => void) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await run();
      after?.(next);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const meta = `from ${alert.raisedBy.name} · ${whenText(alert.createdAt, now)}${alert.confirmedBy ? ` · confirmed by ${alert.confirmedBy.name}` : ""}`;
  return (
    <li className={styles.alertRow} data-level={alert.level} data-resolved={resolved || undefined}>
      <span className={styles.alertKind}>
        <IconAlert size={14} />
        {confirmed ? "Confirmed" : "Suspected"}
      </span>
      <Link href={`/t/${encodeURIComponent(alert.threadId)}${query}`} scroll={false} className={styles.alertText}>
        {alert.text}
      </Link>
      {error ? (
        <span className={styles.alertError} role="alert">
          {error}
        </span>
      ) : (
        <span className={styles.alertMeta}>{meta}</span>
      )}
      {resolved ? (
        <span className={styles.alertResolved} role="status">
          {resolvedText(alert.resolvedBy, alert.resolvedSource)}
        </span>
      ) : (
        <span className={styles.alertActions}>
          {confirmed ? null : (
            <button type="button" className="tk-button" disabled={busy} onClick={() => void act(() => api.confirmAlert(alert.id))}>
              Confirm
            </button>
          )}
          <button
            type="button"
            className="tk-button tk-button-ghost"
            disabled={busy}
            onClick={() => void act(() => api.resolveAlert(alert.id), onResolved)}
          >
            Resolve
          </button>
        </span>
      )}
    </li>
  );
}

/**
 * The room's unresolved alerts, under the tab row on every tab: at most three, confirmed first,
 * the rest behind "n more alerts". There is no dismiss: an alert leaves only when someone resolves
 * it, for everyone. A row the viewer resolves stays a moment to say who resolved it.
 */
export function AlertBanner({ alerts, query, now, onChanged }: { alerts: Alert[]; query: string; now: number; onChanged(): void }) {
  const [expanded, setExpanded] = useState(false);
  const [held, setHeld] = useState<Map<string, Alert>>(new Map());

  useEffect(() => {
    if (held.size === 0) return;
    const t = setTimeout(() => setHeld(new Map()), RESOLVED_HOLD_MS);
    return () => clearTimeout(t);
  }, [held]);

  const { shown, more } = bannerAlerts(alerts.filter((a) => !held.has(a.id)));
  const rows = [...held.values(), ...shown, ...(expanded ? more : [])];
  if (rows.length === 0) return null;
  return (
    <section aria-label="Alerts" aria-live="polite" className={styles.banner}>
      <ul className={styles.alertList}>
        {rows.map((a) => (
          <AlertRow
            key={a.id}
            alert={a}
            query={query}
            now={now}
            onChanged={onChanged}
            onResolved={(r) => setHeld((h) => new Map(h).set(r.id, r))}
          />
        ))}
      </ul>
      {more.length > 0 ? (
        <button type="button" className={styles.alertMore} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show fewer" : `${more.length} more ${more.length === 1 ? "alert" : "alerts"}`}
        </button>
      ) : null}
    </section>
  );
}
