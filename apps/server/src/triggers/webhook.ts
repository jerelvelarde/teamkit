import { createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { BoardEvent } from "@copilotkit/teamkit-protocol";

const PREFIX = "sha256=";

/** "sha256=" + HMAC-SHA256 hex of the exact body string. */
export function signBody(secret: string, body: string): string {
  return PREFIX + createHmac("sha256", secret).update(body).digest("hex");
}

/** Constant-time check of an `X-TeamKit-Signature` header against the raw body. */
export function verifySignature(
  secret: string,
  body: string,
  header: string | null | undefined,
): boolean {
  if (!header) return false;
  const expected = Buffer.from(signBody(secret, body));
  const given = Buffer.from(header);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

export interface WebhookDelivery {
  url: string;
  secret: string;
  triggerName: string;
  event: BoardEvent;
}

export interface WebhookOptions {
  fetch?: typeof fetch;
  attempts?: number;
  backoffMs?: number[];
  timeoutMs?: number;
}

export interface WebhookResult {
  ok: boolean;
  status: number | null;
  attempts: number;
}

/**
 * POST `{ event }` to a trigger's webhook, signed over the exact body.
 * Success is any 2xx. Redirects are not followed (a 3xx counts as a failure),
 * and network errors and timeouts are retried like non-2xx statuses.
 * The receiver can check `event.createdAt` inside the signed body to reject
 * stale replays.
 */
export async function deliverWebhook(
  d: WebhookDelivery,
  opts: WebhookOptions = {},
): Promise<WebhookResult> {
  const doFetch = opts.fetch ?? fetch;
  const attempts = opts.attempts ?? 3;
  const backoffMs = opts.backoffMs ?? [500, 1000];
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const body = JSON.stringify({ event: d.event });
  const headers = {
    "content-type": "application/json",
    "user-agent": "teamkit-webhook/0.1",
    "x-teamkit-event": d.event.cursor,
    "x-teamkit-trigger": d.triggerName,
    "x-teamkit-signature": signBody(d.secret, body),
  };

  let status: number | null = null;
  let made = 0;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      const wait = backoffMs[Math.min(i - 1, backoffMs.length - 1)] ?? 0;
      await sleep(wait);
    }
    made++;
    try {
      const res = await doFetch(d.url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      await res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, status, attempts: made };
      }
    } catch {
      status = null;
    }
  }
  return { ok: false, status, attempts: made };
}
