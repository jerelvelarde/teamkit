"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { IconX } from "./Icons";
import styles from "./board.module.css";

/** The New task dialog's look for one piece of text in a room: a decision, an alert. */
export function TextDialog({
  open,
  title,
  room,
  label,
  placeholder,
  submitLabel,
  busyLabel,
  emptyError,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  room: string;
  label: string;
  placeholder: string;
  submitLabel: string;
  busyLabel: string;
  emptyError: string;
  onSubmit(text: string): Promise<void>;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setError(null);
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setError(null);
    if (text.trim() === "") return setError(emptyError);
    setBusy(true);
    try {
      await onSubmit(text.trim());
      setText("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
    >
      <form className={styles.dialogForm} onSubmit={submit} onKeyDown={onKeyDown}>
        <div className={styles.dialogHead}>
          <h2 id={`${id}-title`} className={styles.dialogTitle}>
            {title}
          </h2>
          <span className="tk-pill">{`#${room}`}</span>
          <span className={styles.headerSpacer} />
          <button type="button" className="tk-button tk-button-ghost tk-icon-button" aria-label="Close" onClick={onClose}>
            <IconX />
          </button>
        </div>

        <label className="tk-visually-hidden" htmlFor={`${id}-text`}>
          {label}
        </label>
        <textarea
          id={`${id}-text`}
          className={styles.briefInput}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={placeholder}
          autoFocus
        />

        {error ? (
          <p className={styles.formError} role="alert">
            {error}
          </p>
        ) : null}

        <div className={styles.dialogActions}>
          <span className={styles.dialogHint}>
            <kbd>⌘</kbd>
            <kbd>↵</kbd> to post
          </span>
          <button type="button" className="tk-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="tk-button tk-button-primary" disabled={busy}>
            {busy ? busyLabel : submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
