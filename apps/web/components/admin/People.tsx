"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { createAdminClient } from "@copilotkit/teamkit-client";
import type { PersonInfo } from "@copilotkit/teamkit-protocol";
import styles from "./admin.module.css";

/** Same-origin admin client: the browser sends the session cookie. */
export const adminApi = createAdminClient({ url: "" });

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function SectionHead({ children }: { children: string }) {
  return (
    <h2 className={styles.sectionHead}>{children}</h2>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  }
  return (
    <button type="button" className="tk-button" onClick={copy}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

/** A secret the server will not show again: link or token. */
export function ShownOnce({
  title,
  value,
  onDismiss,
}: {
  title: string;
  value: string;
  onDismiss: () => void;
}) {
  return (
    <div className={styles.secret} role="status">
      <p className={styles.secretTitle}>{title}</p>
      <p className={styles.warn}>Shown once. You won&apos;t see this again, so store it now.</p>
      <div className={styles.secretRow}>
        <pre className={styles.secretValue}>{value}</pre>
        <div className={styles.secretActions}>
          <CopyButton text={value} />
          <button type="button" className="tk-button" onClick={onDismiss}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function People() {
  const [people, setPeople] = useState<PersonInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ title: string; value: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setPeople(await adminApi.people());
    } catch (err) {
      setError(errorText(err, "Could not load people."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim() === "") return setError("Enter a name to invite.");
    setBusy(true);
    try {
      const res = await adminApi.invitePerson({ name: name.trim(), role: admin ? "admin" : "member" });
      setShown({ title: `Sign-in link for ${res.person.name}`, value: res.link });
      setName("");
      setAdmin(false);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not invite that person."));
    } finally {
      setBusy(false);
    }
  }

  async function newLink(person: string) {
    setError(null);
    try {
      const res = await adminApi.personLink(person);
      setShown({ title: `New sign-in link for ${person}`, value: res.link });
    } catch (err) {
      setError(errorText(err, "Could not create a link."));
    }
  }

  return (
    <section className={`tk-glass ${styles.section}`} aria-label="People">
      <SectionHead>People</SectionHead>

      {shown ? <ShownOnce title={shown.title} value={shown.value} onDismiss={() => setShown(null)} /> : null}

      <div className={styles.tableBox}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {people === null ? (
              <tr>
                <td colSpan={4} className={styles.muted}>
                  Loading…
                </td>
              </tr>
            ) : people.length === 0 ? (
              <tr>
                <td colSpan={4} className={styles.muted}>
                  No people yet.
                </td>
              </tr>
            ) : (
              people.map((p) => (
                <tr key={p.actor.id}>
                  <td>{p.actor.name}</td>
                  <td>
                    <span className="tk-pill">{p.role}</span>
                  </td>
                  <td className={styles.mono}>{formatTime(p.lastSignInAt)}</td>
                  <td>
                    <div className={styles.rowActions}>
                      <button type="button" className="tk-button" onClick={() => newLink(p.actor.name)}>
                        New link
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <form className={styles.form} onSubmit={invite}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Invite by name</span>
          <input
            className={`tk-input ${styles.input}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name"
            autoComplete="off"
          />
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
          Make this person an admin
        </label>
        <div className={`${styles.formActions} ${styles.wide}`}>
          <button type="submit" className={`tk-button ${styles.primary}`} disabled={busy}>
            {busy ? "Inviting…" : "Invite"}
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
