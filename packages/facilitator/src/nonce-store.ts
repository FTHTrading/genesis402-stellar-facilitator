import { DatabaseSync } from "node:sqlite";

export type ClaimStatus = "claimed" | "submitted" | "confirmed" | "failed";

export interface ClaimRecord {
  txHash: string;
  /** Opaque key the claimant (the seller's /settle call) supplied; "" when none. */
  claimKey: string;
  status: ClaimStatus;
}

/**
 * Replay protection for Soroban authorization nonces.
 *
 * The network itself consumes a nonce when the auth entry is applied, so this
 * store is a pre-submit guard: it stops the same signed payload being settled
 * twice through this facilitator (for example, two sellers forwarding the same
 * PAYMENT-SIGNATURE) before the first submission lands. It also remembers who
 * claimed the entry (`claimKey`) and how far the submission got (`status`), so
 * the same claimant can read its own outcome again after a lost response
 * without anyone else being able to.
 *
 * Any method may throw when the backing store is unavailable (locked, closed);
 * callers must map that to a refusal, never to a submission.
 */
export interface NonceStore {
  isConsumed(network: string, payer: string, nonce: string): boolean;
  /** Returns true if the nonce was newly consumed, false if it was already present. */
  consume(network: string, payer: string, nonce: string, txHash: string, claimKey?: string): boolean;
  lookup(network: string, payer: string, nonce: string): ClaimRecord | undefined;
  setStatus(network: string, payer: string, nonce: string, status: ClaimStatus, txHash?: string): void;
  /**
   * Forgets a nonce. Only called when the network definitively did not admit
   * the envelope (sendTransaction ERROR or TRY_AGAIN_LATER), so the signed
   * entry can never have been applied on chain.
   */
  release(network: string, payer: string, nonce: string): void;
}

export interface SqliteNonceStoreOptions {
  /**
   * How long a statement waits on another connection's lock before failing.
   * Kept in rollback-journal mode on purpose: a reader blocked by a writer must
   * fail fast and surface as "store unavailable" rather than read stale state.
   */
  busyTimeoutMs?: number;
}

export class SqliteNonceStore implements NonceStore {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:", opts: SqliteNonceStoreOptions = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 1000))}`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consumed_nonces (
        network   TEXT NOT NULL,
        payer     TEXT NOT NULL,
        nonce     TEXT NOT NULL,
        tx_hash   TEXT NOT NULL,
        consumed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (network, payer, nonce)
      )
    `);
    const cols = (this.db.prepare("PRAGMA table_info(consumed_nonces)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("claim_key")) this.db.exec("ALTER TABLE consumed_nonces ADD COLUMN claim_key TEXT NOT NULL DEFAULT ''");
    if (!cols.includes("status")) this.db.exec("ALTER TABLE consumed_nonces ADD COLUMN status TEXT NOT NULL DEFAULT 'claimed'");
  }

  isConsumed(network: string, payer: string, nonce: string): boolean {
    return this.lookup(network, payer, nonce) !== undefined;
  }

  lookup(network: string, payer: string, nonce: string): ClaimRecord | undefined {
    const row = this.db
      .prepare("SELECT tx_hash, claim_key, status FROM consumed_nonces WHERE network = ? AND payer = ? AND nonce = ?")
      .get(network, payer, nonce) as { tx_hash: string; claim_key: string; status: ClaimStatus } | undefined;
    return row ? { txHash: row.tx_hash, claimKey: row.claim_key, status: row.status } : undefined;
  }

  consume(network: string, payer: string, nonce: string, txHash: string, claimKey = ""): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO consumed_nonces (network, payer, nonce, tx_hash, claim_key, status) VALUES (?, ?, ?, ?, ?, 'claimed')",
      )
      .run(network, payer, nonce, txHash, claimKey);
    return result.changes === 1;
  }

  setStatus(network: string, payer: string, nonce: string, status: ClaimStatus, txHash?: string): void {
    if (txHash !== undefined) {
      this.db
        .prepare("UPDATE consumed_nonces SET status = ?, tx_hash = ? WHERE network = ? AND payer = ? AND nonce = ?")
        .run(status, txHash, network, payer, nonce);
    } else {
      this.db
        .prepare("UPDATE consumed_nonces SET status = ? WHERE network = ? AND payer = ? AND nonce = ?")
        .run(status, network, payer, nonce);
    }
  }

  release(network: string, payer: string, nonce: string): void {
    this.db
      .prepare("DELETE FROM consumed_nonces WHERE network = ? AND payer = ? AND nonce = ?")
      .run(network, payer, nonce);
  }

  close(): void {
    this.db.close();
  }
}
