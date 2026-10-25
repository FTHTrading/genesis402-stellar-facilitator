/** The subset of D1 the limiter uses, so tests can run the same SQL on node:sqlite. */
export interface SqlStatement {
  bind(...params: unknown[]): SqlStatement;
  run(): Promise<{ meta: { changes: number } }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface SqlDb {
  prepare(sql: string): SqlStatement;
  exec(sql: string): Promise<unknown>;
}

export interface LimiterOptions {
  windowMs: number;
  perAddress: number;
  perIp: number;
}

export type Reservation =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; scope: "address" | "ip"; retryAfterSec: number };

const SCHEMA = `CREATE TABLE IF NOT EXISTS claim_counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL, window_start INTEGER NOT NULL)`;

/*
 * One statement both checks and takes a slot, so concurrent requests cannot
 * both pass the check (S2). D1 runs statements one at a time per database.
 * ?1 key, ?2 now, ?3 now - window, ?4 limit. changes = 1 means a slot was taken.
 */
const RESERVE = `INSERT INTO claim_counters (k, n, window_start) VALUES (?1, 1, ?2)
ON CONFLICT(k) DO UPDATE SET
  n = CASE WHEN claim_counters.window_start <= ?3 THEN 1 ELSE claim_counters.n + 1 END,
  window_start = CASE WHEN claim_counters.window_start <= ?3 THEN ?2 ELSE claim_counters.window_start END
WHERE claim_counters.window_start <= ?3 OR claim_counters.n < ?4`;

const RELEASE = `UPDATE claim_counters SET n = n - 1 WHERE k = ?1 AND n > 0`;
const WINDOW_OF = `SELECT window_start FROM claim_counters WHERE k = ?1`;

export class ClaimLimiter {
  private schemaReady: Promise<unknown> | null = null;

  constructor(
    private readonly db: SqlDb,
    private readonly opts: LimiterOptions,
  ) {}

  private ensureSchema(): Promise<unknown> {
    this.schemaReady ??= this.db.exec(SCHEMA).catch((err) => {
      this.schemaReady = null;
      throw err;
    });
    return this.schemaReady;
  }

  private async take(key: string, now: number, limit: number): Promise<boolean> {
    const res = await this.db.prepare(RESERVE).bind(key, now, now - this.opts.windowMs, limit).run();
    return res.meta.changes === 1;
  }

  private async give(key: string): Promise<void> {
    await this.db.prepare(RELEASE).bind(key).run();
  }

  private async retryAfter(key: string, now: number): Promise<number> {
    const row = await this.db.prepare(WINDOW_OF).bind(key).first<{ window_start: number }>();
    const start = row ? Number(row.window_start) : now;
    return Math.max(1, Math.ceil((start + this.opts.windowMs - now) / 1000));
  }

  /** Takes the address slot, then the IP slot; if the IP slot is refused the address slot is handed back. */
  async reserve(token: string, address: string, ip: string, now: number): Promise<Reservation> {
    await this.ensureSchema();
    const addrKey = `${token}|a|${address}`;
    const ipKey = `${token}|i|${ip}`;
    if (!(await this.take(addrKey, now, this.opts.perAddress))) {
      return { ok: false, scope: "address", retryAfterSec: await this.retryAfter(addrKey, now) };
    }
    if (!(await this.take(ipKey, now, this.opts.perIp))) {
      await this.give(addrKey);
      return { ok: false, scope: "ip", retryAfterSec: await this.retryAfter(ipKey, now) };
    }
    let released = false;
    return {
      ok: true,
      release: async () => {
        if (released) return;
        released = true;
        await this.give(addrKey);
        await this.give(ipKey);
      },
    };
  }
}
