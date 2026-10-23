import { DatabaseSync } from "node:sqlite";
import type { PaymentRequirements } from "./x402.js";

export type PendingState = "inflight" | "pending" | "expired";

/**
 * What a seller remembers about one payment it has sent (or is about to send)
 * to the facilitator. Written **before** `/settle`, so a crash or a lost answer
 * never loses the claim key; the key is what lets this seller, and only this
 * seller, read the outcome back.
 */
export interface PendingRecord {
  /** sha256 of the PAYMENT-SIGNATURE header. */
  digest: string;
  resourceKey: string;
  method: string;
  requirements: PaymentRequirements;
  claimKey: string;
  txHash?: string;
  state: PendingState;
  createdAt: number;
  expiresAt: number;
}

/**
 * Durable, shareable memory of in-progress payments. `withLock` serializes all
 * work on one payment digest, across every seller instance that shares the
 * store; that serialization is what makes "one payment, one delivery" hold
 * across a seller restart or a fleet.
 */
export interface PendingStore {
  withLock<T>(digest: string, fn: () => Promise<T>): Promise<T>;
  get(digest: string): Promise<PendingRecord | undefined>;
  put(record: PendingRecord): Promise<void>;
  delete(digest: string): Promise<void>;
}

/** Default: one process, one instance. Lost on restart; pass a shared store to survive one. */
export class InMemoryPendingStore implements PendingStore {
  private readonly records = new Map<string, PendingRecord>();
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly maxRecords = 1000) {}

  async withLock<T>(digest: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(digest) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tracked = run.then(() => undefined, () => undefined);
    this.locks.set(digest, tracked);
    try {
      return await run;
    } finally {
      if (this.locks.get(digest) === tracked) this.locks.delete(digest);
    }
  }
  async get(digest: string): Promise<PendingRecord | undefined> {
    return this.records.get(digest);
  }
  async put(record: PendingRecord): Promise<void> {
    if (!this.records.has(record.digest) && this.records.size >= this.maxRecords) {
      const oldest = this.records.keys().next().value;
      if (oldest) this.records.delete(oldest);
    }
    this.records.set(record.digest, record);
  }
  async delete(digest: string): Promise<void> {
    this.records.delete(digest);
  }
}

export interface SqlitePendingStoreOptions {
  /** A lock older than this is considered abandoned (process died) and can be taken over. Default 30 s. */
  leaseMs?: number;
  /** Poll interval while waiting for a lock. Default 15 ms. */
  pollMs?: number;
  busyTimeoutMs?: number;
}

/**
 * SQLite-backed store usable from several seller processes on one host (or a
 * shared volume). Locks are leases in a table, taken with a single atomic
 * UPDATE, so two processes retrying the same payment take turns.
 */
export class SqlitePendingStore implements PendingStore {
  private readonly db: DatabaseSync;
  private readonly leaseMs: number;
  private readonly pollMs: number;

  constructor(path: string, opts: SqlitePendingStoreOptions = {}) {
    this.db = new DatabaseSync(path);
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.pollMs = opts.pollMs ?? 15;
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 2000))}`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_payments (
        digest TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_locks (
        digest TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        leased_until INTEGER NOT NULL
      );
    `);
  }

  async withLock<T>(digest: string, fn: () => Promise<T>): Promise<T> {
    const owner = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const acquire = this.db.prepare(
      `INSERT INTO pending_locks (digest, owner, leased_until) VALUES (?, ?, ?)
       ON CONFLICT(digest) DO UPDATE SET owner = excluded.owner, leased_until = excluded.leased_until
       WHERE pending_locks.leased_until < ?`,
    );
    const deadline = Date.now() + this.leaseMs * 2;
    for (;;) {
      const now = Date.now();
      const r = acquire.run(digest, owner, now + this.leaseMs, now);
      if (r.changes === 1) break;
      if (Date.now() > deadline) throw new Error("pending store lock wait exceeded");
      await new Promise((res) => setTimeout(res, this.pollMs));
    }
    try {
      return await fn();
    } finally {
      this.db.prepare("DELETE FROM pending_locks WHERE digest = ? AND owner = ?").run(digest, owner);
    }
  }

  async get(digest: string): Promise<PendingRecord | undefined> {
    const row = this.db.prepare("SELECT record FROM pending_payments WHERE digest = ?").get(digest) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as PendingRecord) : undefined;
  }

  async put(record: PendingRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO pending_payments (digest, record, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(digest) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at`,
      )
      .run(record.digest, JSON.stringify(record), Date.now());
  }

  async delete(digest: string): Promise<void> {
    this.db.prepare("DELETE FROM pending_payments WHERE digest = ?").run(digest);
  }

  close(): void {
    this.db.close();
  }
}
