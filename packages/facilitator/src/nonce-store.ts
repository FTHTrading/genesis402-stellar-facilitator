import { DatabaseSync } from "node:sqlite";

/**
 * Replay protection for Soroban authorization nonces.
 *
 * The network itself consumes a nonce when the auth entry is applied, so this
 * store is a pre-submit guard: it stops the same signed payload being settled
 * twice through this facilitator (for example, two sellers forwarding the same
 * PAYMENT-SIGNATURE) before the first submission lands.
 */
export interface NonceStore {
  isConsumed(network: string, payer: string, nonce: string): boolean;
  /** Returns true if the nonce was newly consumed, false if it was already present. */
  consume(network: string, payer: string, nonce: string, txHash: string): boolean;
}

export class SqliteNonceStore implements NonceStore {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
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
    const row = this.db
      .prepare("SELECT 1 AS present FROM consumed_nonces WHERE network = ? AND payer = ? AND nonce = ?")
      .get(network, payer, nonce);
    return row !== undefined;
  }

  consume(network: string, payer: string, nonce: string, txHash: string): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO consumed_nonces (network, payer, nonce, tx_hash) VALUES (?, ?, ?, ?)",
      )
      .run(network, payer, nonce, txHash);
    return result.changes === 1;
  }

  close(): void {
    this.db.close();
  }
}
