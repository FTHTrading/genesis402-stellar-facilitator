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

/** Thrown by `withLock` when another holder keeps the digest busy for longer than the wait bound. */
export class PendingStoreBusyError extends Error {
  readonly code = "pending_store_busy" as const;
  constructor(message = "another request holds this payment") {
    super(message);
    this.name = "PendingStoreBusyError";
  }
}

/** True when an error is SQLite's "database is locked" (SQLITE_BUSY) past the busy timeout. */
export function isStoreBusyError(err: unknown): boolean {
  if (err instanceof PendingStoreBusyError) return true;
  const e = err as { code?: string; errcode?: number; message?: string };
  return e?.code === "ERR_SQLITE_ERROR" && (/database is locked|SQLITE_BUSY/i.test(e.message ?? "") || e.errcode === 5);
}

/** Handed to the function running under a lock; `held()` is a live check, not a cached flag. */
export interface LeaseHandle {
  held(): boolean;
}

/**
 * Durable, shareable memory of in-progress payments. `withLock` serializes all
 * work on one payment digest across every seller instance that shares the
 * store. Two rules make "one payment, one delivery" hold even when a lease is
 * lost under a slow request: `consume` is the only way to deliver (an atomic
 * delete-if-owner that succeeds once), and `update` is the only way to change a
 * record after the write-ahead `put` (an owner-checked conditional update that
 * never inserts, so a consumed record cannot be resurrected).
 */
export interface PendingStore {
  withLock<T>(digest: string, fn: (lease: LeaseHandle) => Promise<T>): Promise<T>;
  get(digest: string): Promise<PendingRecord | undefined>;
  /** Write-ahead insert. Replaces only an absent record or a tombstone; false when a live record exists. */
  put(record: PendingRecord): Promise<boolean>;
  /** Owner-checked, state-checked conditional update of a live record; never inserts. */
  update(record: PendingRecord): Promise<boolean>;
  delete(digest: string): Promise<void>;
  /** Atomically removes the record iff it still carries `claimKey`; true exactly once. */
  consume(digest: string, claimKey: string): Promise<boolean>;
}

const LIVE: ReadonlySet<PendingState> = new Set(["inflight", "pending"]);
const ALWAYS_HELD: LeaseHandle = { held: () => true };

export interface InMemoryPendingStoreOptions {
  maxTombstones?: number;
  /** How long a caller waits for a busy digest before `PendingStoreBusyError`. Default 15 s. */
  lockWaitMs?: number;
  /** Live records untouched for this long are collected (abandoned 409s, crashed in-flight rows). Default 7 days. */
  abandonedLiveMs?: number;
}

/**
 * Default: one process, one instance. Lost on restart; pass a shared store to
 * survive one. Live records are never evicted for space; when the tombstone
 * bound is reached the oldest tombstones go first. Live records untouched for
 * `abandonedLiveMs` are collected.
 */
export class InMemoryPendingStore implements PendingStore {
  private readonly records = new Map<string, PendingRecord>();
  private readonly touched = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly maxTombstones: number;
  private readonly lockWaitMs: number;
  private readonly abandonedLiveMs: number;
  constructor(opts: number | InMemoryPendingStoreOptions = {}) {
    const o = typeof opts === "number" ? { maxTombstones: opts } : opts;
    this.maxTombstones = o.maxTombstones ?? 1000;
    this.lockWaitMs = o.lockWaitMs ?? 15_000;
    this.abandonedLiveMs = o.abandonedLiveMs ?? 7 * 24 * 3_600_000;
  }

  async withLock<T>(digest: string, fn: (lease: LeaseHandle) => Promise<T>): Promise<T> {
    const previous = this.locks.get(digest);
    if (previous) {
      // Bounded wait: a holder that outlives `lockWaitMs` leaves the second caller with 503, never a hang.
      const got = await Promise.race([previous.then(() => true, () => true), new Promise<false>((r) => setTimeout(() => r(false), this.lockWaitMs))]);
      if (!got) throw new PendingStoreBusyError();
    }
    const run = (this.locks.get(digest) ?? Promise.resolve()).then(() => fn(ALWAYS_HELD), () => fn(ALWAYS_HELD));
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
  async put(record: PendingRecord): Promise<boolean> {
    const existing = this.records.get(record.digest);
    if (existing && LIVE.has(existing.state)) return false;
    this.records.set(record.digest, record);
    this.touched.set(record.digest, Date.now());
    this.collect();
    return true;
  }
  async update(record: PendingRecord): Promise<boolean> {
    const existing = this.records.get(record.digest);
    if (!existing || existing.claimKey !== record.claimKey || !LIVE.has(existing.state)) return false;
    this.records.set(record.digest, record);
    this.touched.set(record.digest, Date.now());
    return true;
  }
  async delete(digest: string): Promise<void> {
    this.records.delete(digest);
    this.touched.delete(digest);
  }
  async consume(digest: string, claimKey: string): Promise<boolean> {
    const rec = this.records.get(digest);
    if (!rec || rec.claimKey !== claimKey) return false;
    this.records.delete(digest);
    this.touched.delete(digest);
    return true;
  }
  private collect(): void {
    const now = Date.now();
    let tombstones = 0;
    for (const [d, r] of this.records) {
      if (r.state === "expired") tombstones++;
      else if (now - (this.touched.get(d) ?? now) > this.abandonedLiveMs) {
        this.records.delete(d);
        this.touched.delete(d);
      }
    }
    if (tombstones > this.maxTombstones) {
      const oldest = [...this.records.values()].filter((r) => r.state === "expired").sort((a, b) => a.expiresAt - b.expiresAt);
      for (const r of oldest.slice(0, tombstones - this.maxTombstones)) {
        this.records.delete(r.digest);
        this.touched.delete(r.digest);
      }
    }
  }
}

export interface SqlitePendingStoreOptions {
  /** Lease length for a lock; renewed every third of it while the holder runs. Default 30 s. */
  leaseMs?: number;
  /** Poll interval while waiting for a lock. Default 15 ms. */
  pollMs?: number;
  /** How long a caller waits for a busy digest before `PendingStoreBusyError`. Default 15 s. */
  lockWaitMs?: number;
  /** Tombstones older than this past their expiry are swept. Default 24 h. */
  tombstoneRetentionMs?: number;
  /** At most this many tombstones are kept; the oldest beyond it are swept. Default 10,000. */
  maxTombstones?: number;
  /** Live records not updated for this long are collected (abandoned 409s, crashed in-flight rows). Default 7 days. */
  abandonedLiveMs?: number;
  /** Sweeps run at most this often (or when more than 1,000 tombstones were written since the last one). Default 60 s. */
  sweepIntervalMs?: number;
  busyTimeoutMs?: number;
}

/**
 * SQLite-backed store usable from several seller processes on one host (or a
 * shared volume). Locks are leases in a table, taken with a single atomic
 * UPDATE and renewed while the holder runs; `held()` re-reads the lock row, so
 * a holder whose lease was taken over learns it before writing or delivering.
 * Correctness of delivery does not rest on the lease: `consume` and `update`
 * are the atomic, owner-checked gates.
 */
export class SqlitePendingStore implements PendingStore {
  private readonly db: DatabaseSync;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly lockWaitMs: number;
  private readonly retentionMs: number;
  private readonly maxTombstones: number;
  private readonly abandonedLiveMs: number;
  private readonly sweepIntervalMs: number;
  private lastSweep = 0;
  private tombstoneWritesSinceSweep = 0;

  constructor(path: string, opts: SqlitePendingStoreOptions = {}) {
    this.db = new DatabaseSync(path);
    this.leaseMs = Math.max(50, opts.leaseMs ?? 30_000);
    this.pollMs = opts.pollMs ?? 15;
    this.lockWaitMs = opts.lockWaitMs ?? 15_000;
    this.retentionMs = opts.tombstoneRetentionMs ?? 24 * 3_600_000;
    this.maxTombstones = opts.maxTombstones ?? 10_000;
    this.abandonedLiveMs = opts.abandonedLiveMs ?? 7 * 24 * 3_600_000;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 2000))}`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_payments (
        digest TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        claim_key TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'pending',
        expires_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS pending_locks (
        digest TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        leased_until INTEGER NOT NULL
      );
    `);
    // Upgrade a pre-r4 file. Several processes may open the same file at once; a column another
    // process just added is not an error.
    for (const [col, ddl] of [
      ["claim_key", "ALTER TABLE pending_payments ADD COLUMN claim_key TEXT NOT NULL DEFAULT ''"],
      ["state", "ALTER TABLE pending_payments ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'"],
      ["expires_at", "ALTER TABLE pending_payments ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      const cols = (this.db.prepare("PRAGMA table_info(pending_payments)").all() as Array<{ name: string }>).map((c) => c.name);
      if (cols.includes(col)) continue;
      try {
        this.db.exec(ddl);
      } catch (err) {
        if (!/duplicate column/i.test(String((err as Error).message))) throw err;
      }
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS pending_payments_state_expires ON pending_payments(state, expires_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS pending_payments_state_updated ON pending_payments(state, updated_at)");
  }

  async withLock<T>(digest: string, fn: (lease: LeaseHandle) => Promise<T>): Promise<T> {
    const owner = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const acquire = this.db.prepare(
      `INSERT INTO pending_locks (digest, owner, leased_until) VALUES (?, ?, ?)
       ON CONFLICT(digest) DO UPDATE SET owner = excluded.owner, leased_until = excluded.leased_until
       WHERE pending_locks.leased_until < ?`,
    );
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      const now = Date.now();
      const r = acquire.run(digest, owner, now + this.leaseMs, now);
      if (r.changes === 1) break;
      if (Date.now() > deadline) throw new PendingStoreBusyError();
      await new Promise((res) => setTimeout(res, this.pollMs));
    }
    const renew = this.db.prepare("UPDATE pending_locks SET leased_until = ? WHERE digest = ? AND owner = ?");
    const whose = this.db.prepare("SELECT owner, leased_until FROM pending_locks WHERE digest = ?");
    const lease: LeaseHandle = {
      held: () => {
        try {
          const row = whose.get(digest) as { owner: string; leased_until: number } | undefined;
          return !!row && row.owner === owner && row.leased_until > Date.now();
        } catch {
          return false; // cannot prove the lease: act as if it were lost
        }
      },
    };
    const timer = setInterval(() => {
      try {
        renew.run(Date.now() + this.leaseMs, digest, owner);
      } catch {
        /* a failed renewal only shortens the lease; held() reports the truth before any write */
      }
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    timer.unref?.();
    try {
      this.maybeSweep();
      return await fn(lease);
    } finally {
      clearInterval(timer);
      try {
        this.db.prepare("DELETE FROM pending_locks WHERE digest = ? AND owner = ?").run(digest, owner);
      } catch {
        /* a lease we cannot release expires on its own */
      }
    }
  }

  async get(digest: string): Promise<PendingRecord | undefined> {
    const row = this.db.prepare("SELECT record FROM pending_payments WHERE digest = ?").get(digest) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as PendingRecord) : undefined;
  }

  async put(record: PendingRecord): Promise<boolean> {
    const r = this.db
      .prepare(
        `INSERT INTO pending_payments (digest, record, updated_at, claim_key, state, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(digest) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at,
           claim_key = excluded.claim_key, state = excluded.state, expires_at = excluded.expires_at
         WHERE pending_payments.state = 'expired'`,
      )
      .run(record.digest, JSON.stringify(record), Date.now(), record.claimKey, record.state, record.expiresAt);
    if (record.state === "expired") this.tombstoneWritesSinceSweep++;
    return r.changes === 1;
  }

  async update(record: PendingRecord): Promise<boolean> {
    const r = this.db
      .prepare(
        `UPDATE pending_payments SET record = ?, updated_at = ?, state = ?, expires_at = ?
         WHERE digest = ? AND claim_key = ? AND state IN ('pending', 'inflight')`,
      )
      .run(JSON.stringify(record), Date.now(), record.state, record.expiresAt, record.digest, record.claimKey);
    if (record.state === "expired" && r.changes === 1) this.tombstoneWritesSinceSweep++;
    return r.changes === 1;
  }

  async delete(digest: string): Promise<void> {
    this.db.prepare("DELETE FROM pending_payments WHERE digest = ?").run(digest);
  }

  async consume(digest: string, claimKey: string): Promise<boolean> {
    const r = this.db.prepare("DELETE FROM pending_payments WHERE digest = ? AND claim_key = ?").run(digest, claimKey);
    return r.changes === 1;
  }

  /** Runs `sweep` when the interval has passed or many tombstones were written since the last one. */
  maybeSweep(now = Date.now()): void {
    if (now - this.lastSweep >= this.sweepIntervalMs || this.tombstoneWritesSinceSweep > 1000) this.sweep(now);
  }

  /**
   * Hygiene, all on indexed columns: tombstones past retention, tombstones beyond the cap (newest
   * kept), and live rows nobody has touched for `abandonedLiveMs`. Fresh live rows are never touched.
   */
  sweep(now = Date.now()): void {
    this.db.prepare("DELETE FROM pending_payments WHERE state = 'expired' AND expires_at < ?").run(now - this.retentionMs);
    this.db
      .prepare(
        `DELETE FROM pending_payments WHERE state = 'expired' AND digest IN (
           SELECT digest FROM pending_payments WHERE state = 'expired' ORDER BY expires_at DESC LIMIT -1 OFFSET ?)`,
      )
      .run(this.maxTombstones);
    this.db
      .prepare("DELETE FROM pending_payments WHERE state IN ('pending', 'inflight') AND updated_at < ?")
      .run(now - this.abandonedLiveMs);
    this.lastSweep = now;
    this.tombstoneWritesSinceSweep = 0;
  }

  close(): void {
    this.db.close();
  }
}
