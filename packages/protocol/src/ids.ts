export const ID_PREFIXES = {
  thread: "th",
  claim: "cl",
  actor: "ac",
  token: "tok",
  interrupt: "in",
  run: "run",
  trigger: "tr",
  message: "msg",
} as const;

export function newId(prefix: string): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `${prefix}_${hex}`;
}

export function newTokenSecret(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes));
  return "tk_" + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
