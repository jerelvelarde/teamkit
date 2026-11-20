import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Db } from "../../src/db/pool.js";
import type { Notifier } from "../../src/notifier.js";
import type { OutboundOptions } from "../../src/slack/outbound.js";

export interface SlackRequest {
  /** The Web API method: the request path's last segment, such as chat.postMessage. */
  method: string;
  auth: string | undefined;
  contentType: string | undefined;
  body: any;
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * A Slack Web API stand-in. Each request takes the next scripted reply, in request order. Once the
 * script runs out, replies default by method: chat.postMessage succeeds with ts "1.000", "2.000", ...
 * (counting default postMessage replies), chat.update echoes the ts it was given, pins.add succeeds.
 */
export async function fakeSlack(script: FakeReply[] = []): Promise<{ requests: SlackRequest[]; apiBase: string; close(): Promise<void> }> {
  const requests: SlackRequest[] = [];
  let posts = 0;
  const queue = [...script];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const method = (req.url ?? "").split("?")[0]!.split("/").pop() ?? "";
      const body = raw === "" ? {} : JSON.parse(raw);
      requests.push({ method, auth: req.headers.authorization, contentType: req.headers["content-type"], body });
      const next = queue.shift();
      if (next) {
        res.writeHead(next.status ?? 200, { "content-type": "application/json", ...next.headers });
        res.end(JSON.stringify(next.body ?? {}));
        return;
      }
      res.setHeader("content-type", "application/json");
      if (method === "chat.update") res.end(JSON.stringify({ ok: true, ts: body.ts }));
      else if (method === "chat.postMessage") res.end(JSON.stringify({ ok: true, ts: `${++posts}.000` }));
      else res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    requests,
    apiBase,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** A notifier that never fires. */
export const idleNotifier: Notifier = { onEvent: () => () => {}, close: async () => {} };

/** Outbound options against the stand-in, with a fixed token and board URL and no logging. */
export function outboundOptions(db: Db, apiBase: string): OutboundOptions {
  return {
    db,
    notifier: idleNotifier,
    slack: { token: "fake-bot-token", apiBase },
    publicUrl: "http://board.test",
    log: () => {},
  };
}
