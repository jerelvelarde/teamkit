"use client";

import { useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import { normalizeJoinName, type Whoami } from "@copilotkit/teamkit-protocol";
import { postJson } from "../lib/api";
import { joinErrorMessage, joinNameHint, type JoinErrorView } from "../lib/join";
import { useWhoami } from "../lib/session";
import { ServerUnavailable } from "./SignedOut";
import styles from "./auth.module.css";

type Result = { kind: "idle" } | { kind: "joined"; name: string } | { kind: "error"; view: JoinErrorView };

export function JoinTeam() {
  const params = useParams<{ code: string }>();
  const { state, who, refresh } = useWhoami();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>({ kind: "idle" });

  if (state === "loading") return null;
  if (state === "unavailable") return <ServerUnavailable onRetry={refresh} />;

  if (result.kind === "joined") {
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    return (
      <section className={`tk-glass ${styles.panel}`} aria-live="polite">
        <h2 className={styles.title}>You&apos;re in, {result.name}.</h2>
        <p className={styles.text}>
          Connect your agent: run <code className={styles.mono}>teamkit join {origin}</code> and approve the code it shows.
        </p>
        <div className={styles.form}>
          <button type="button" className={`tk-button ${styles.submit}`} onClick={() => window.location.replace("/")}>
            Open the board
          </button>
        </div>
      </section>
    );
  }

  if (state === "signed_in" && who) {
    return (
      <section className={`tk-glass ${styles.panel}`}>
        <p className={styles.text}>You&apos;re signed in as {who.actor.name}.</p>
        <p className={styles.text}>
          <a href="/">Open the board</a>
        </p>
      </section>
    );
  }

  const normalized = normalizeJoinName(name);

  async function join(e: FormEvent) {
    e.preventDefault();
    if (normalized === null) return;
    setBusy(true);
    try {
      const joined = await postJson<Whoami>("/v1/join", { code: params.code, name, email });
      setResult({ kind: "joined", name: joined.actor.name });
    } catch (err) {
      setResult({ kind: "error", view: joinErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`tk-glass ${styles.panel}`} aria-live="polite">
      <h2 className={styles.title}>Join your team on AG-UI TeamKit</h2>
      <p className={styles.text}>Pick the name your teammates will see.</p>
      <form className={styles.codeForm} onSubmit={join}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Name</span>
          <input
            className="tk-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ana"
            autoComplete="username"
            spellCheck={false}
          />
          <span className={styles.detail}>
            {joinNameHint(name)}
          </span>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Email</span>
          <input
            className="tk-input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ana@example.com"
          />
        </label>
        <button type="submit" className={`tk-button ${styles.submit}`} disabled={busy || normalized === null}>
          Join
        </button>
      </form>
      {result.kind === "error" ? (
        <p className={styles.error}>
          {result.view.message}
          {result.view.offerEmailSignIn ? (
            <>
              {" "}
              <a href="/signin">Email me a sign-in link</a>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
