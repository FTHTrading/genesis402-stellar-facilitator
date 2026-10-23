import { DatabaseSync } from "node:sqlite";

/**
 * Replay protection for Soroban authorization nonces.
 *
 * The network itself consumes a nonce when the auth entry is applied, so this
 * store is a pre-submit guard: it stops the same signed payload being settled
 * twice through this facilitator (for example, two sellers forwarding the same
 * PAYMENT-SIGNATURE) before the first submission lands.
 *
 * Any method may throw when the backing store is unavailable (locked, closed);
 * callers must map that to a refusal, never to a submission.
 */
export interface NonceStore {
  isConsumed(network: string, payer: string, nonce: string): boolean;
  /** Returns true if the nonce was newly consumed, false if it was already present. */
  consume(network: string, payer: string, nonce: string, txHash: string): boolean;
  /** Transaction hash recorded when the nonce was consumed, if any. */
  lookup(network: string, payer: string, nonce: string): string | undefined;
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
  }

  isConsumed(network: string, payer: string, nonce: string): boolean {
    return this.lookup(network, payer, nonce) !== undefined;
  }

  lookup(network: string, payer: string, nonce: string): string | undefined {
    const row = this.db
      .prepare("SELECT tx_hash FROM consumed_nonces WHERE network = ? AND payer = ? AND nonce = ?")
      .get(network, payer, nonce) as { tx_hash: string } | undefined;
    return row?.tx_hash;
  }

  consume(network: string, payer: string, nonce: string, txHash: string): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO consumed_nonces (network, payer, nonce, tx_hash) VALUES (?, ?, ?, ?)",
      )
      .run(network, payer, nonce, txHash);
    return result.changes === 1;
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
