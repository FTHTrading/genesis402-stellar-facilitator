import { DatabaseSync } from "node:sqlite";
import type { SqlDb, SqlStatement } from "../src/ratelimit.js";

/**
 * A D1-shaped wrapper over node:sqlite so the limiter's real SQL runs in tests.
 * Every call yields to the event loop before executing, which lets 20 parallel
 * requests interleave the way they would against D1.
 */
export function sqliteD1(): SqlDb {
  const db = new DatabaseSync(":memory:");
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    prepare(sql: string): SqlStatement {
      const make = (params: unknown[]): SqlStatement => ({
        bind: (...next: unknown[]) => make(next),
        async run() {
          await tick();
          const res = db.prepare(sql).run(...(params as never[]));
          return { meta: { changes: Number(res.changes) } };
        },
        async first<T>() {
          await tick();
          return (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
        },
      });
      return make([]);
    },
    async exec(sql: string) {
      await tick();
      db.exec(sql);
    },
  };
}
