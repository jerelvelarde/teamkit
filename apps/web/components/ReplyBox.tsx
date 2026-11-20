"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { api } from "../lib/api";
import { IconSend } from "./Icons";
import styles from "./thread.module.css";

const MAX_HEIGHT = 200;

/** Slack's composer: Enter sends, Shift+Enter starts a new line, the box grows with the text. */
export function ReplyBox({ threadId, onSent }: { threadId: string; onSent(): void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
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

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  const empty = text.trim() === "";

  return (
    <form className={styles.composer} onSubmit={send}>
      <label className="tk-visually-hidden" htmlFor="tk-reply">
        Reply
      </label>
      <textarea
        id="tk-reply"
        ref={box}
        className={styles.composerInput}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Reply to this thread"
      />
      <div className={styles.composerBar}>
        <span className={styles.composerHint}>
          <strong>Shift + Enter</strong> for a new line
        </span>
        <button
          type="submit"
          className={styles.send}
          disabled={busy || empty}
          aria-label={busy ? "Sending" : "Send reply"}
          title="Send reply"
        >
          <IconSend size={15} />
        </button>
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
