import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Database, D1PreparedStatement, D1Result } from "../src/types.js";

class Stmt implements D1PreparedStatement {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new Stmt(this.db, this.sql, values as SQLInputValue[]);
  }

  async first<T = unknown>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.values) as T | undefined;
    return row ?? null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...this.values) as T[];
    return { results, success: true };
  }

  async run(): Promise<{ success: boolean; meta: { last_row_id?: number; changes?: number } }> {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.values);
    return {
      success: true,
      meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) },
    };
  }
}

export function createMemoryD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  return {
    prepare(query: string) {
      return new Stmt(db, query);
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const out: D1Result<T>[] = [];
      for (const s of statements) out.push(await s.all<T>());
      return out;
    },
    async exec(query: string) {
      db.exec(query);
      return {};
    },
  };
}
