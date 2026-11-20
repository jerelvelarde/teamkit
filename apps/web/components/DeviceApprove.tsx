"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { personAgentName, type ActorRef, type RoomSummary } from "@copilotkit/teamkit-protocol";
import { api, postJson } from "../lib/api";
import { deviceErrorMessage, deviceMode, roomsToApprove } from "../lib/device";
import { useWhoami } from "../lib/session";
import { ServerUnavailable, SignedOut } from "./SignedOut";
import styles from "./auth.module.css";

type Result = { kind: "idle" } | { kind: "approved"; agent?: string } | { kind: "error"; message: string };

export function DeviceApprove() {
  const params = useSearchParams();
  const initial = params.get("code") ?? "";
  const mode = deviceMode(params);
  const { state, who, refresh } = useWhoami();
  const [code, setCode] = useState(initial.toUpperCase());
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (mode !== "agent" || state !== "signed_in") return;
    let live = true;
    api.rooms().then(
      (list) => live && setRooms(list),
      () => live && setRooms([]),
    );
    return () => {
      live = false;
    };
  }, [mode, state]);

  if (state === "loading") return null;
  if (state === "signed_out") {
    return (
      <SignedOut
        hint={
          mode === "agent"
            ? "Join your team with its join link first, then reopen this page."
            : "Sign in with your invite link first, then reopen this page."
        }
      />
    );
  }
  if (state === "unavailable") return <ServerUnavailable onRetry={refresh} />;

  const agent = who ? personAgentName(who.actor.name) : "your agent";
  const picked = roomsToApprove(checked, typed);

  async function approve(e: FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    try {
      if (mode === "agent") {
        const out = await postJson<{ ok: true; agent?: ActorRef }>("/v1/device/approve", {
          userCode: code.trim(),
          rooms: picked.rooms,
        });
        setResult({ kind: "approved", agent: out.agent?.name ?? agent });
      } else {
        await postJson("/v1/device/approve", { userCode: code.trim() });
        setResult({ kind: "approved" });
      }
    } catch (err) {
      setResult({ kind: "error", message: deviceErrorMessage(err, mode) });
    } finally {
      setBusy(false);
    }
  }

  const codeField = (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>Code shown in your terminal</span>
      <input
        className={`tk-input ${styles.codeDisplay}`}
        value={code}
        onChange={(e) => {
          setCode(e.target.value.toUpperCase());
          // The confirmation is for the code on screen; a new code needs a new one.
          setConfirmed(false);
        }}
        placeholder="BCDF-GHJK"
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );

  if (mode === "agent") {
    const ready = !busy && code.trim() !== "" && confirmed && picked.rooms.length > 0 && picked.invalid.length === 0;
    return (
      <section className={`tk-glass ${styles.panel}`} aria-live="polite">
        <h2 className={styles.title}>Connect your agent</h2>
        <p className={styles.text}>
          This signs in {agent}, an agent that belongs to you. It can read, post, claim and create tasks in the rooms you
          pick.
        </p>
        {result.kind === "approved" ? (
          <p className={styles.success}>{result.agent ?? agent} is connected. Return to your agent.</p>
        ) : (
          <>
            <p className={styles.warning}>Never approve a code someone sent you.</p>
            <form className={styles.codeForm} onSubmit={approve}>
              {codeField}
              <fieldset className={styles.field}>
                <legend className={styles.fieldLabel}>Rooms</legend>
                {rooms !== null && rooms.length === 0 ? (
                  <p className={styles.detail}>No rooms yet. Type one below.</p>
                ) : null}
                {(rooms ?? []).map((r) => (
                  <label key={r.name} className={styles.check}>
                    <input
                      type="checkbox"
                      checked={checked.includes(r.name)}
                      onChange={(e) =>
                        setChecked((prev) => (e.target.checked ? [...prev, r.name] : prev.filter((n) => n !== r.name)))
                      }
                    />
                    <span>{r.name}</span>
                  </label>
                ))}
              </fieldset>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Other rooms</span>
                <input
                  className="tk-input"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="billing-migration"
                  autoComplete="off"
                  spellCheck={false}
                />
                {picked.invalid.map((x) => (
                  <span key={x} className={styles.error}>
                    Not a room name: {x}
                  </span>
                ))}
              </label>
              <label className={styles.check}>
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>
                  This code matches the one my agent printed, and I just ran{" "}
                  <code className={styles.mono}>teamkit join</code>
                </span>
              </label>
              <button type="submit" className={`tk-button ${styles.submit}`} disabled={!ready}>
                Connect {agent}
              </button>
            </form>
          </>
        )}
        {result.kind === "error" ? <p className={styles.error}>{result.message}</p> : null}
      </section>
    );
  }

  return (
    <section className={`tk-glass ${styles.panel}`} aria-live="polite">
      <h2 className={styles.title}>Approve a command-line sign-in</h2>
      <p className={styles.text}>
        This lets the teamkit command-line tool run admin commands as you. It cannot post, claim or
        answer.
      </p>
      {result.kind === "approved" ? (
        <p className={styles.success}>Approved. You can return to your terminal.</p>
      ) : (
        <>
          <p className={styles.warning}>Never approve a code someone sent you.</p>
          <form className={styles.codeForm} onSubmit={approve}>
            {codeField}
            <label className={styles.check}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>
                This code matches the one in my own terminal, and I just ran{" "}
                <code className={styles.mono}>teamkit login</code>
              </span>
            </label>
            <button
              type="submit"
              className={`tk-button ${styles.submit}`}
              disabled={busy || !code.trim() || !confirmed}
            >
              Approve this sign-in
            </button>
          </form>
        </>
      )}
      {result.kind === "error" ? <p className={styles.error}>{result.message}</p> : null}
    </section>
  );
}
