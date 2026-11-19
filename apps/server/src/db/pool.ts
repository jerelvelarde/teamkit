import postgres from "postgres";

export type Db = postgres.Sql;
export type Tx = postgres.TransactionSql;
export type Q = Db | Tx;

export function createDb(url: string, opts?: { max?: number }): Db {
  return postgres(url, { max: opts?.max ?? 10, onnotice: () => {} });
}
