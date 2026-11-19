/** One Slack Web API call, classified as ok, retry (try the same work later) or permanent. */

export interface SlackApi {
  token: string;
  apiBase?: string;
  fetch?: typeof fetch;
}

export type SlackMethod = "chat.postMessage" | "chat.update" | "pins.add";

export type SlackResult =
  | { kind: "ok"; ts: string | null }
  | { kind: "retry"; reason: string; afterMs: number | null }
  | { kind: "permanent"; reason: string; error: string };

/** A call that hangs this long counts as a network failure. */
const CALL_TIMEOUT_MS = 15_000;

/**
 * Slack error codes that say nothing about the one call: a rate limit or an outage, or a token
 * or app setup problem that fails every call the same way until it is fixed. Any other Slack
 * error is about this call (the channel is gone, the message was deleted) and will not go away
 * by retrying.
 */
export const RETRYABLE_SLACK_ERRORS: ReadonlySet<string> = new Set([
  "ratelimited",
  "rate_limited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "missing_scope",
  "ekm_access_denied",
]);

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim()) * 1000;
}

/**
 * POSTs `body` as JSON to `<apiBase>/<method>`. The token only goes into the Authorization header;
 * reasons carry the HTTP status or Slack's error code, never the token.
 */
export async function callSlack(api: SlackApi, method: SlackMethod, body: Record<string, unknown>): Promise<SlackResult> {
  const doFetch = api.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${api.apiBase ?? "https://slack.com/api"}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${api.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: "retry", reason: `request failed (${err instanceof Error ? err.name : "error"})`, afterMs: null };
  }
  if (res.status === 429 || res.status >= 500) {
    return { kind: "retry", reason: `http ${res.status}`, afterMs: retryAfterMs(res) };
  }
  if (!res.ok) return { kind: "permanent", reason: `http ${res.status}`, error: `http_${res.status}` };
  let json: { ok?: boolean; ts?: string; error?: string };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return { kind: "retry", reason: "unreadable response", afterMs: null };
  }
  if (json.ok === true) return { kind: "ok", ts: typeof json.ts === "string" ? json.ts : null };
  const error = typeof json.error === "string" ? json.error : "unknown";
  if (RETRYABLE_SLACK_ERRORS.has(error)) {
    return { kind: "retry", reason: `slack error ${error}`, afterMs: retryAfterMs(res) };
  }
  return { kind: "permanent", reason: `slack error ${error}`, error };
}
