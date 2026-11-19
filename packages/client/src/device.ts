import type { ActorRef, DevicePoll, DeviceStart } from "@copilotkit/teamkit-protocol";
import { TeamkitError, toError } from "./client.js";

export interface DeviceOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface WaitForDeviceOptions extends DeviceOptions {
  /** Pause between polls. Defaults to setTimeout, cut short by `signal`. */
  sleep?: (ms: number) => Promise<void>;
}

const cancelled = () => new TeamkitError("aborted", 0, "login cancelled");

async function post<T>(
  url: string,
  path: string,
  body: unknown,
  opts: DeviceOptions,
): Promise<T> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${url.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw cancelled();
    throw e;
  }
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

/** Asks the server for a login code. Show `userCode` and `verifyUrl` to the person. */
export function startDeviceLogin(url: string, opts: DeviceOptions = {}): Promise<DeviceStart> {
  return post<DeviceStart>(url, "/v1/device/start", {}, opts);
}

/** One check of a login code: pending, expired, or approved (the token is handed out once). */
export function pollDeviceLogin(url: string, deviceCode: string, opts: DeviceOptions = {}): Promise<DevicePoll> {
  return post<DevicePoll>(url, "/v1/device/poll", { deviceCode }, opts);
}

function abortableSleep(signal?: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    });
}

/** Polls every `start.intervalMs` until the login is approved, expires, or `signal` aborts. */
export async function waitForDeviceLogin(
  url: string,
  start: DeviceStart,
  opts: WaitForDeviceOptions = {},
): Promise<{ token: string; actor: ActorRef }> {
  const sleep = opts.sleep ?? abortableSleep(opts.signal);
  for (;;) {
    if (opts.signal?.aborted) throw cancelled();
    const poll = await pollDeviceLogin(url, start.deviceCode, { fetch: opts.fetch, signal: opts.signal });
    if (poll.status === "approved") return { token: poll.token, actor: poll.actor };
    if (poll.status === "expired") throw new TeamkitError("expired", 410, "login code expired");
    await sleep(start.intervalMs);
  }
}
