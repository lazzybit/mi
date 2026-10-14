// Thin SQL abstraction shared by the Durable Object (`ctx.storage.sql`) and the
// Node test backend (`node:sqlite`). Business modules never touch a concrete
// driver (PLAN.md -> Persistence and scheduling).

export type SqlValue = string | number | bigint | boolean | null | ArrayBuffer | Uint8Array;

export interface SqlCursor<T> {
  toArray(): T[];
}

export interface SqlExecutor {
  exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}

export interface StorageBackend {
  readonly sql: SqlExecutor;
  /** Synchronous transaction. The callback must not return a promise. */
  transactionSync<T>(fn: () => T): T;
}

export function all<T>(sql: SqlExecutor, query: string, ...bindings: SqlValue[]): T[] {
  return sql.exec<T>(query, ...bindings).toArray();
}

export function first<T>(sql: SqlExecutor, query: string, ...bindings: SqlValue[]): T | undefined {
  return sql.exec<T>(query, ...bindings).toArray()[0];
}

export function run(sql: SqlExecutor, query: string, ...bindings: SqlValue[]): void {
  sql.exec(query, ...bindings);
}

export function count(sql: SqlExecutor, query: string, ...bindings: SqlValue[]): number {
  const row = first<{ n: number }>(sql, query, ...bindings);
  return row ? Number(row.n) : 0;
}

export function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

export function intToBool(value: unknown): boolean {
  return Number(value) !== 0;
}

/** JSON helpers that tolerate legacy/partial rows. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Split a list into bounded batches for parameterized `IN (...)` deletes. */
export function chunk<T>(values: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size) as T[]);
  }
  return batches;
}
