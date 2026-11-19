export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "task_claimed"
  | "claim_lost"
  | "invalid_state"
  | "approval_requires_person"
  | "too_large";

export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  task_claimed: 409,
  claim_lost: 409,
  invalid_state: 409,
  approval_requires_person: 403,
  too_large: 413,
};

export class BoardError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "BoardError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

export function isBoardError(e: unknown): e is BoardError {
  if (e instanceof BoardError) return true;
  if (typeof e !== "object" || e === null) return false;
  const o = e as { name?: unknown; code?: unknown };
  return (
    o.name === "BoardError" &&
    typeof o.code === "string" &&
    Object.prototype.hasOwnProperty.call(ERROR_STATUS, o.code)
  );
}

export function errorBody(e: BoardError): { error: { code: string; message: string } } {
  return { error: { code: e.code, message: e.message } };
}
