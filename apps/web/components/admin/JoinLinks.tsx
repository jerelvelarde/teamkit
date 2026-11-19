"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { CreatedJoinLink, JoinLink, JoinLinkInput } from "@copilotkit/teamkit-protocol";
import { joinLinkStatus, parseDays, parseDomains } from "../../lib/join-links";
import { adminApi, errorText, SectionHead, ShownOnce } from "./People";
import { formatDate } from "./Tokens";
import styles from "./admin.module.css";

/** The team's join links: create one (shown once), see how often each was used, revoke it. */
export function JoinLinks() {
  const [links, setLinks] = useState<JoinLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [domains, setDomains] = useState("");
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedJoinLink | null>(null);

  const load = useCallback(async () => {
    try {
      setLinks(await adminApi.joinLinks());
    } catch (err) {
      setError(errorText(err, "Could not load join links."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let input: JoinLinkInput;
    try {
      const list = parseDomains(domains);
      const expiresInDays = parseDays(days);
      input = { ...(list.length > 0 ? { domains: list } : {}), ...(expiresInDays === undefined ? {} : { expiresInDays }) };
    } catch (err) {
      return setError(errorText(err, "Check the domains and the expiry."));
    }
    setBusy(true);
    try {
      setCreated(await adminApi.createJoinLink(input));
      setDomains("");
      setDays("");
      await load();
    } catch (err) {
      setError(errorText(err, "Could not create the join link."));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(link: JoinLink) {
    if (!window.confirm("Revoke this join link? People who have it can no longer join with it.")) return;
    setError(null);
    try {
      await adminApi.revokeJoinLink(link.id);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not revoke the join link."));
    }
  }

  const now = Date.now();
  return (
    <section className={`tk-glass ${styles.section}`} aria-label="Join links">
      <SectionHead>Join links</SectionHead>
      <p className={styles.lead}>Anyone with a join link can join as a member. Revoke it to stop new joins.</p>

      {created ? <ShownOnce title="New join link" value={created.link} onDismiss={() => setCreated(null)} /> : null}

      <div className={styles.tableBox}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Created</th>
              <th>Domains</th>
              <th>Expires</th>
              <th>Uses</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {links === null ? (
              <tr>
                <td colSpan={6} className={styles.muted}>
                  Loading…
                </td>
              </tr>
            ) : links.length === 0 ? (
              <tr>
                <td colSpan={6} className={styles.muted}>
                  No join links yet.
                </td>
              </tr>
            ) : (
              links.map((l) => {
                const status = joinLinkStatus(l, now);
                return (
                  <tr key={l.id} className={status === "active" ? "" : styles.revoked}>
                    <td className={styles.mono}>{formatDate(l.createdAt)}</td>
                    <td>{l.domains && l.domains.length > 0 ? l.domains.join(", ") : "Any"}</td>
                    <td className={styles.mono}>{l.expiresAt ? formatDate(l.expiresAt) : "Never"}</td>
                    <td className={styles.num}>{l.uses}</td>
                    <td>{status}</td>
                    <td>
                      <div className={styles.rowActions}>
                        {status === "active" ? (
                          <button type="button" className={`tk-button ${styles.danger}`} onClick={() => void revoke(l)}>
                            Revoke
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <form className={styles.form} onSubmit={create}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Email domains (comma-separated, empty for any)</span>
          <input
            className={`tk-input ${styles.input}`}
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            placeholder="example.com"
            autoComplete="off"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Expires after (days, empty for never)</span>
          <input
            className={`tk-input ${styles.input}`}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            placeholder="30"
            inputMode="numeric"
            autoComplete="off"
          />
        </label>
        <div className={`${styles.formActions} ${styles.wide}`}>
          <button type="submit" className={`tk-button ${styles.primary}`} disabled={busy}>
            {busy ? "Creating…" : "Create join link"}
          </button>
        </div>
      </form>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
