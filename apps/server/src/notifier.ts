import type { Db } from "./db/pool.js";

/**
 * A subscriber gets the new event's cursor, or `null` after the listener has
 * reconnected: notifications sent while it was down are lost, so `null` means
 * "events may have been missed; re-check from your own cursor". Treat every call
 * as a reason to re-read, never as the cursor to read from.
 */
export type NotifierCallback = (cursor: string | null) => void;

export interface Notifier {
  onEvent(cb: NotifierCallback): () => void;
  close(): Promise<void>;
}

const CHANNEL = "teamkit_events";

export async function createNotifier(db: Db): Promise<Notifier> {
  const callbacks = new Set<NotifierCallback>();
  let closed = false;
  const fire = (cursor: string | null) => {
    for (const cb of [...callbacks]) {
      try {
        cb(cursor);
      } catch (err) {
        console.error("notifier callback threw", err);
      }
    }
  };
  // postgres.js calls onlisten after the first LISTEN and again each time it
  // re-listens on a new connection after the old one dropped.
  let listening = false;
  const listener = await db.listen(CHANNEL, fire, () => {
    if (!listening) {
      listening = true;
      return;
    }
    fire(null);
  });
  return {
    onEvent(cb) {
      callbacks.add(cb);
      return () => {
        callbacks.delete(cb);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      // Clearing matters: after a reconnect, postgres.js's unlisten no longer
      // removes the re-registered listener.
      callbacks.clear();
      await listener.unlisten();
    },
  };
}
