import { createClient, toError } from "@copilotkit/teamkit-client";

/** Same-origin client: the browser sends the session cookie. */
export const api = createClient({ url: "" });

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}
