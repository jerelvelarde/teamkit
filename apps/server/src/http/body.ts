import type { Context } from "hono";
import { BoardError, type EventKind, type EventQuery } from "@copilotkit/teamkit-protocol";

type Body = Record<string, unknown>;

const invalid = (message: string): BoardError => new BoardError("invalid_input", message);

export async function readBody(c: Context): Promise<Body> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid("request body must be a JSON object");
  }
  return parsed as Body;
}

export function reqString(b: Body, key: string): string {
  const v = b[key];
  if (typeof v !== "string") throw invalid(`${key} is required and must be a string`);
  return v;
}

export function optString(b: Body, key: string): string | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw invalid(`${key} must be a string`);
  return v;
}

export function optStringArray(b: Body, key: string): string[] | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw invalid(`${key} must be an array of strings`);
  }
  return v as string[];
}

export function optLabels(b: Body, key: string): Record<string, string> | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw invalid(`${key} must be an object of strings`);
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") throw invalid(`${key}.${k} must be a string`);
    out[k] = val;
  }
  return out;
}

export function labelsFromQuery(values?: string[]): Record<string, string> | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const raw of values) {
    const i = raw.indexOf("=");
    if (i <= 0) throw invalid(`label "${raw}" must be key=value with a non-empty key`);
    out[raw.slice(0, i)] = raw.slice(i + 1);
  }
  return out;
}

export function eventQueryFromRequest(c: Context): EventQuery {
  const q: EventQuery = {};
  const after = c.req.query("after");
  if (after !== undefined) q.after = after;
  const room = c.req.query("room");
  if (room !== undefined) q.room = room;
  const thread = c.req.query("thread");
  if (thread !== undefined) q.thread = thread;
  const kinds = c.req.queries("kind");
  if (kinds !== undefined && kinds.length > 0) q.kinds = kinds as EventKind[];
  const limit = c.req.query("limit");
  if (limit !== undefined) {
    if (!/^-?\d+$/.test(limit)) throw invalid("limit must be an integer");
    q.limit = Number(limit);
  }
  return q;
}
