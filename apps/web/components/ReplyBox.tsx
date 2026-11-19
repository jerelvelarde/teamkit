"use client";

import { useState } from "react";
import { api } from "../lib/api";
import styles from "./thread.module.css";

export function ReplyBox({ threadId, onSent }: { threadId: string; onSent(): void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.reply(threadId, body);
      setText("");
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the reply.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`tk-glass ${styles.form}`} onSubmit={send}>
      <label className={styles.label} htmlFor="tk-reply">
        Reply
      </label>
      <textarea
        id="tk-reply"
        className={`tk-input ${styles.textarea}`}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Write a reply to this thread"
      />
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button type="submit" className="tk-button" disabled={busy || text.trim() === ""}>
          {busy ? "Sending…" : "Send reply"}
        </button>
      </div>
    </form>
  );
}
