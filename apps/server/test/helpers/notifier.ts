import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import type { Notifier } from "../../src/notifier.js";

export type CountingNotifier = Notifier & { live(): number };

/** Wraps a notifier and counts its live subscriptions, so a test can assert none leak. */
export function countingNotifier(inner: Notifier): CountingNotifier {
  let live = 0;
  return {
    onEvent(cb) {
      const unsubscribe = inner.onEvent(cb);
      live++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        live--;
        unsubscribe();
      };
    },
    close: () => inner.close(),
    live: () => live,
  };
}

/** Polls until `live()` equals `want` or `timeoutMs` passes; returns the last count seen. */
export async function liveCount(n: { live(): number }, want: number, timeoutMs = 2000): Promise<number> {
  const end = Date.now() + timeoutMs;
  while (n.live() !== want && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return n.live();
}

/** Serves `app` on a random local port over real sockets. */
export async function serveApp(app: Hono): Promise<{ url: string; close(): Promise<void> }> {
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  }
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
