import type { Db } from "./db/pool.js";

export interface Notifier {
  onEvent(cb: (cursor: string) => void): () => void;
  close(): Promise<void>;
}

const CHANNEL = "teamkit_events";

export async function createNotifier(db: Db): Promise<Notifier> {
  const callbacks = new Set<(cursor: string) => void>();
  let closed = false;
  const listener = await db.listen(CHANNEL, (payload) => {
    for (const cb of [...callbacks]) {
      try {
        cb(payload);
      } catch (err) {
        console.error("notifier callback threw", err);
      }
    }
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
      callbacks.clear();
      await listener.unlisten();
    },
  };
}
