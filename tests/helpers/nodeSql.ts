import { DatabaseSync } from "node:sqlite";
import type { SqlCursor, SqlExecutor, SqlValue, StorageBackend } from "../../src/worker/storage/Sql";

/**
 * `node:sqlite` implementation of the storage backend used by the unit runner.
 * It mirrors the Durable Object `ctx.storage.sql` surface closely enough that
 * the same `SqlStore` code runs in tests and in workerd.
 */
export class NodeSqlBackend implements StorageBackend {
  readonly sql: SqlExecutor;
  private depth = 0;

  constructor(readonly db: DatabaseSync = new DatabaseSync(":memory:")) {
    this.sql = {
      exec: <T>(query: string, ...bindings: SqlValue[]): SqlCursor<T> => {
        const statement = this.db.prepare(query);
        const rows = statement.all(...(bindings as never[])) as T[];
        return { toArray: () => rows };
      },
    };
  }

  transactionSync<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN");
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.depth--;
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
