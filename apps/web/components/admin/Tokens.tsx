"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { PERMISSIONS } from "@copilotkit/teamkit-protocol";
import type { CreatedToken, Permission, TokenInfo } from "@copilotkit/teamkit-protocol";
import { adminApi, errorText, SectionHead, ShownOnce } from "./People";
import styles from "./admin.module.css";

interface GrantRow {
  key: number;
  room: string;
  perms: Permission[];
}

let nextKey = 1;
const newRow = (): GrantRow => ({ key: nextKey++, room: "", perms: ["read", "post", "claim"] });

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function Tokens() {
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [count, setCount] = useState("1");
  const [rows, setRows] = useState<GrantRow[]>(() => [newRow()]);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedToken[] | null>(null);

  const load = useCallback(async () => {
    try {
      setTokens(await adminApi.tokens());
    } catch (err) {
      setError(errorText(err, "Could not load tokens."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function patchRow(key: number, patch: Partial<GrantRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function togglePerm(row: GrantRow, perm: Permission) {
    const perms = row.perms.includes(perm) ? row.perms.filter((p) => p !== perm) : [...row.perms, perm];
    patchRow(row.key, { perms: PERMISSIONS.filter((p) => perms.includes(p)) });
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const n = Number(count);
    if (name.trim() === "") return setError("Enter a name for the agent.");
    if (!Number.isInteger(n) || n < 1 || n > 100) return setError("Count must be a whole number from 1 to 100.");
    const grants = rows
      .map((r) => ({ room: r.room.trim(), perms: r.perms }))
      .filter((r) => r.room !== "" || r.perms.length > 0);
    if (grants.length === 0) return setError("Add at least one room pattern.");
    if (grants.some((g) => g.room === "")) return setError("Every grant needs a room pattern.");
    if (grants.some((g) => g.perms.length === 0)) return setError("Every grant needs at least one permission.");
    setBusy(true);
    try {
      const res = await adminApi.createTokens({ name: name.trim(), rooms: grants, count: n });
      setCreated(res);
      setName("");
      setCount("1");
      setRows([newRow()]);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not create tokens."));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: TokenInfo) {
    if (!window.confirm(`Revoke the token for ${t.actorName}? Agents using it stop working right away.`)) return;
    setError(null);
    try {
      await adminApi.revokeToken(t.id);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not revoke the token."));
    }
  }

  return (
    <section className={`tk-glass ${styles.section}`} aria-label="Agent tokens">
      <SectionHead>Agent tokens</SectionHead>

      {created ? (
        <ShownOnce
          title={created.length === 1 ? "New agent token" : `${created.length} new agent tokens`}
          value={created.map((c) => `${c.actor.name}\t${c.token}`).join("\n")}
          onDismiss={() => setCreated(null)}
        />
      ) : null}

      <div className={styles.tableBox}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Scope</th>
              <th>Created</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens === null ? (
              <tr>
                <td colSpan={5} className={styles.muted}>
                  Loading…
                </td>
              </tr>
            ) : tokens.length === 0 ? (
              <tr>
                <td colSpan={5} className={styles.muted}>
                  No tokens yet.
                </td>
              </tr>
            ) : (
              tokens.map((t) => (
                <tr key={t.id} className={t.revokedAt ? styles.revoked : ""}>
                  <td>{t.actorName}</td>
                  <td>
                    <span className="tk-pill">{t.scope}</span>
                  </td>
                  <td className={styles.mono}>{formatDate(t.createdAt)}</td>
                  <td>{t.revokedAt ? "revoked" : "active"}</td>
                  <td>
                    <div className={styles.rowActions}>
                      {t.revokedAt ? null : (
                        <button type="button" className={`tk-button ${styles.danger}`} onClick={() => revoke(t)}>
                          Revoke
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <form className={styles.form} onSubmit={create}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Agent name</span>
          <input
            className={`tk-input ${styles.input}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="agent name"
            autoComplete="off"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>How many (1 to 100)</span>
          <input
            className={`tk-input ${styles.input}`}
            type="number"
            min={1}
            max={100}
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </label>
        <div className={`${styles.field} ${styles.wide}`}>
          <span className={styles.fieldLabel}>Rooms and permissions</span>
          <div className={styles.grants}>
            {rows.map((row) => (
              <div key={row.key} className={styles.grantRow}>
                <input
                  className={`tk-input ${styles.input}`}
                  value={row.room}
                  onChange={(e) => patchRow(row.key, { room: e.target.value })}
                  placeholder="room name, or * for all rooms"
                  aria-label="Room pattern"
                />
                <div className={styles.perms}>
                  {PERMISSIONS.map((perm) => (
                    <label key={perm} className={styles.check}>
                      <input type="checkbox" checked={row.perms.includes(perm)} onChange={() => togglePerm(row, perm)} />
                      {perm}
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className="tk-button"
                  onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}
                  disabled={rows.length === 1}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className={styles.formActions}>
            <button type="button" className="tk-button" onClick={() => setRows((rs) => [...rs, newRow()])}>
              Add room
            </button>
          </div>
        </div>
        <div className={`${styles.formActions} ${styles.wide}`}>
          <button type="submit" className={`tk-button ${styles.primary}`} disabled={busy}>
            {busy ? "Creating…" : "Create tokens"}
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
