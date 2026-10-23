import { Account, Asset, Keypair, Networks, type Transaction } from "@stellar/stellar-sdk";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChainClient, SimulationResult, TransferEvent } from "../src/chain.js";
import { StellarFacilitator } from "../src/facilitator.js";
import { SqliteNonceStore } from "../src/nonce-store.js";
import { CURRENT_LEDGER, USDC_TESTNET, facilitator, requirements, signedPayload } from "./helpers.js";
import { MockChain } from "./mock-chain.js";

/** Ledger-faithful: the account sequence only advances when a transaction is applied. */
class LedgerLikeChain implements ChainClient {
  ledgerSeq = 500n;
  readonly accepted: Transaction[] = [];
  readonly rejected: string[] = [];
  private pending = new Set<string>();
  async getLatestLedger() {
    return CURRENT_LEDGER;
  }
  async estimatedLedgerSeconds() {
    return 5;
  }
  async getAccount(address: string) {
    return new Account(address, this.ledgerSeq.toString());
  }
  async simulate(_tx: Transaction, expected: TransferEvent): Promise<SimulationResult> {
    await new Promise((r) => setTimeout(r, 5));
    return { ok: true, minResourceFee: "1000", transfers: [expected], assemble: (t) => t };
  }
  async send(tx: Transaction) {
    const hash = Buffer.from(tx.hash()).toString("hex");
    if (this.pending.has(tx.sequence) || BigInt(tx.sequence) !== this.ledgerSeq + 1n) {
      this.rejected.push(tx.sequence);
      return { status: "TRY_AGAIN_LATER", hash, error: "TRY_AGAIN_LATER" };
    }
    this.pending.add(tx.sequence);
    this.accepted.push(tx);
    return { status: "PENDING", hash };
  }
  async waitForTransaction() {
    await new Promise((r) => setTimeout(r, 10));
    this.ledgerSeq += BigInt(this.pending.size);
    this.pending.clear();
    return { status: "SUCCESS" };
  }
}

function make(chain: ChainClient, extra: Partial<ConstructorParameters<typeof StellarFacilitator>[0]> = {}) {
  return new StellarFacilitator({
    network: "stellar:testnet",
    signer: facilitator,
    chain,
    nonceStore: new SqliteNonceStore(":memory:"),
    ...extra,
  });
}

describe("I-1 settles are serialized per facilitator account", () => {
  it("two buyers settling concurrently both succeed with consecutive sequence numbers", async () => {
    const chain = new LedgerLikeChain();
    const f = make(chain);
    const req = requirements();
    const [pa, pb] = await Promise.all([
      signedPayload(req, { payerKp: Keypair.random() }),
      signedPayload(req, { payerKp: Keypair.random() }),
    ]);
    const [ra, rb] = await Promise.all([f.settle(pa, req), f.settle(pb, req)]);
    expect(chain.rejected).toEqual([]);
    expect(ra.success && rb.success).toBe(true);
    expect(chain.accepted.map((t) => t.sequence)).toEqual(["501", "502"]);
  });

  it("releases the nonce when the network answers TRY_AGAIN_LATER so the buyer can retry", async () => {
    const chain = new MockChain({
      currentLedger: CURRENT_LEDGER,
      facilitatorAddress: facilitator.publicKey(),
      sendStatus: "TRY_AGAIN_LATER",
    });
    const f = make(chain);
    const req = requirements();
    const p = await signedPayload(req);
    const r = await f.settle(p, req);
    expect(r).toMatchObject({ success: false, errorReason: "settle_exact_stellar_transaction_submission_failed", transaction: "" });
    expect(await f.verify(p, req)).toMatchObject({ isValid: true });
  });

  it("keeps the nonce claimed when send throws (ambiguous: the envelope may have reached the network)", async () => {
    class Throwing extends MockChain {
      override async send(): Promise<{ status: string; hash: string }> {
        throw new Error("socket hang up");
      }
    }
    const f = make(new Throwing({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() }));
    const req = requirements();
    const p = await signedPayload(req);
    expect((await f.settle(p, req)).success).toBe(false);
    expect(await f.settle(p, req)).toMatchObject({ success: false, errorReason: "invalid_exact_stellar_payload_nonce_reused" });
  });

  it("a replayed payload is refused but the refusal names the transaction that consumed it", async () => {
    const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    const f = make(chain);
    const req = requirements();
    const p = await signedPayload(req);
    const first = await f.settle(p, req);
    const again = await f.settle(p, req);
    expect(again).toMatchObject({ success: false, errorReason: "invalid_exact_stellar_payload_nonce_reused" });
    expect(again.transaction).toBe(first.transaction);
  });
});

describe("I-2 asset allowlist", () => {
  it("refuses any token contract outside the allowlist before simulating or spending", async () => {
    const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    const f = make(chain);
    const junk = new Asset("JUNK", Keypair.random().publicKey()).contractId(Networks.TESTNET);
    const req = requirements({ asset: junk });
    expect(await f.verify(await signedPayload(req), req)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_asset_not_allowed",
    });
    expect((await f.settle(await signedPayload(req), req)).success).toBe(false);
    expect(chain.sent).toHaveLength(0);
  });

  it("defaults to Circle USDC on the network and accepts extra contracts only when configured", async () => {
    const demo = new Asset("TUSDC", Keypair.random().publicKey()).contractId(Networks.TESTNET);
    const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    expect([...make(chain).allowedAssets]).toEqual([USDC_TESTNET]);
    const f = make(chain, { allowedAssets: [USDC_TESTNET, demo] });
    const req = requirements({ asset: demo });
    expect(await f.verify(await signedPayload(req), req)).toMatchObject({ isValid: true });
  });
});

describe("M-8 the facilitator is never the recipient", () => {
  it("refuses payTo equal to the facilitator address", async () => {
    const f = make(new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() }));
    const req = requirements({ payTo: facilitator.publicKey() });
    expect(await f.verify(await signedPayload(req), req)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_facilitator_is_recipient",
    });
  });
});

describe("M-2 / M-3 nonce store under lock", () => {
  const path = () => join(mkdtempSync(join(tmpdir(), "g402-r1-")), "n.sqlite");

  it("verify answers isValid=false (not a throw) when the database is locked", async () => {
    const p = path();
    const store = new SqliteNonceStore(p, { busyTimeoutMs: 100 });
    const other = new DatabaseSync(p);
    other.exec("BEGIN EXCLUSIVE");
    try {
      const f = make(new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() }), { nonceStore: store });
      const req = requirements();
      expect(await f.verify(await signedPayload(req), req)).toMatchObject({ isValid: false, invalidReason: "nonce_store_unavailable" });
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
  });

  it("settle under a write lock refuses with an empty transaction and sends nothing", async () => {
    const p = path();
    const store = new SqliteNonceStore(p, { busyTimeoutMs: 100 });
    const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    const f = make(chain, { nonceStore: store });
    const req = requirements();
    const payload = await signedPayload(req);
    const other = new DatabaseSync(p);
    other.exec("BEGIN IMMEDIATE");
    try {
      const r = await f.settle(payload, req);
      expect(r).toMatchObject({ success: false, errorReason: "nonce_store_unavailable", transaction: "" });
      expect(chain.sent).toHaveLength(0);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
  });
});

describe("M-11 no raw error text in API responses", () => {
  it("simulation errors come back as a code only", async () => {
    const f = make(new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey(), simulationError: "HostError at 10.0.3.7" }));
    const req = requirements();
    const r = await f.verify(await signedPayload(req), req);
    expect(JSON.stringify(r)).not.toContain("10.0.3.7");
    expect(r.invalidReason).toBe("invalid_exact_stellar_payload_simulation_failed");
  });
});
