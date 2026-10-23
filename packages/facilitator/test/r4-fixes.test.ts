import { Account, Keypair, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { ChainClient, SimulationResult, TransferEvent } from "../src/chain.js";
import { StellarFacilitator } from "../src/facilitator.js";
import { SqliteNonceStore } from "../src/nonce-store.js";
import { CURRENT_LEDGER, facilitator, requirements, signedPayload } from "./helpers.js";
import { MockChain } from "./mock-chain.js";

const mk = (chain: ChainClient, extra: Partial<ConstructorParameters<typeof StellarFacilitator>[0]> = {}) =>
  new StellarFacilitator({ network: "stellar:testnet", signer: facilitator, chain, nonceStore: new SqliteNonceStore(":memory:"), log: () => {}, ...extra });

/** Ledger whose height moves and whose send can be made to hang (claimed, never submitted). */
class Moving implements ChainClient {
  height = CURRENT_LEDGER;
  hangSend = false;
  stallLedgerMs = 0;
  readonly submitted = new Set<string>();
  readonly applied = new Set<string>();
  async getLatestLedger() {
    if (this.stallLedgerMs) await new Promise((r) => setTimeout(r, this.stallLedgerMs));
    return this.height;
  }
  async estimatedLedgerSeconds() {
    return 5;
  }
  async getAccount(a: string) {
    return new Account(a, "7");
  }
  async simulate(_t: Transaction, e: TransferEvent): Promise<SimulationResult> {
    return { ok: true, minResourceFee: "1000", transfers: [e], assemble: (t) => t };
  }
  async send(tx: Transaction) {
    if (this.hangSend) return new Promise<{ status: string; hash: string }>(() => undefined);
    const hash = Buffer.from(tx.hash()).toString("hex");
    this.submitted.add(hash);
    return { status: "PENDING", hash };
  }
  async waitForTransaction(hash: string) {
    if (this.submitted.has(hash)) this.applied.add(hash);
    return { status: this.applied.has(hash) ? "SUCCESS" : "NOT_FOUND" };
  }
}

describe("I-r4-2 the claimant can read its outcome after the entry's expiry ledger", () => {
  it("nonce lookup precedes the expiry check: same claim key -> success with hash; other key -> nonce_reused with hash", async () => {
    const chain = new Moving();
    const f = mk(chain);
    const req = requirements();
    const p = await signedPayload(req, { validUntilLedgerSeq: CURRENT_LEDGER + 8 });
    const r1 = await f.settle(p, req, { claimKey: "owner-r4-000001" });
    expect(r1.success).toBe(true);
    chain.height = CURRENT_LEDGER + 20; // past the entry's ledger
    const owner = await f.settle(p, req, { claimKey: "owner-r4-000001" });
    expect(owner).toMatchObject({ success: true, transaction: r1.transaction });
    const other = await f.settle(p, req, { claimKey: "someone-else-r4" });
    expect(other).toMatchObject({ success: false, errorReason: "invalid_exact_stellar_payload_nonce_reused", transaction: r1.transaction });
    expect((await f.verify(p, req)).invalidReason).toBe("invalid_exact_stellar_payload_nonce_reused");
    expect(chain.submitted.size).toBe(1);
  });

  it("an unconsumed entry past its ledger is still refused as expired", async () => {
    const chain = new Moving();
    const f = mk(chain);
    const req = requirements();
    const p = await signedPayload(req, { validUntilLedgerSeq: CURRENT_LEDGER + 8 });
    chain.height = CURRENT_LEDGER + 8;
    expect((await f.verify(p, req)).invalidReason).toBe("invalid_exact_stellar_signature_expired");
  });
});

describe("M-r4-1 a never-submitted claim is released once the entry can no longer be applied", () => {
  it("the claiming payload itself triggers the release on the next check; nothing is ever submitted", async () => {
    const chain = new Moving();
    chain.hangSend = true;
    const logs: string[] = [];
    const f = mk(chain, { settleDeadlineMs: 150, log: (m) => logs.push(m) });
    const req = requirements();
    const p = await signedPayload(req, { validUntilLedgerSeq: CURRENT_LEDGER + 5 });
    expect((await f.settle(p, req, { claimKey: "owner-r4-000002" })).errorReason).toBe("unexpected_settle_error");
    chain.height = CURRENT_LEDGER + 4;
    expect((await f.settle(p, req, { claimKey: "intruder-r4-0001" })).errorReason).toBe("invalid_exact_stellar_payload_nonce_reused");
    chain.height = CURRENT_LEDGER + 5;
    const v = await f.verify(p, req);
    expect(v.invalidReason).toBe("invalid_exact_stellar_signature_expired");
    expect(logs.some((l) => l.startsWith("releasing stale claim"))).toBe(true);
    expect((await f.settle(p, req, { claimKey: "owner-r4-000002" })).success).toBe(false);
    expect(chain.submitted.size).toBe(0);
  });
});

describe("M-r4-2 fee share", () => {
  it("rejects a per-seller share larger than the global budget at startup", () => {
    expect(() => mk(new Moving(), { feeBudgetStroopsPerHour: 5_000_000, feeBudgetPerSellerStroopsPerHour: 10_000_000 })).toThrow(/exceeds/);
    // A defaulted share is clamped to the budget rather than refused (a tiny or fail-closed budget must still construct).
    expect(mk(new Moving(), { feeBudgetStroopsPerHour: 100, maxTransactionFeeStroops: 50_000 }).feeBudgetPerSellerStroopsPerHour).toBe(100);
    expect(mk(new Moving(), { feeBudgetStroopsPerHour: Number.NaN }).feeBudgetPerSellerStroopsPerHour).toBe(0);
  });

  it("in bearer mode the share is keyed by the token: rotating payTo does not widen it", async () => {
    const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey(), minResourceFee: "1000" });
    const f = mk(chain, { feeBudgetPerSellerStroopsPerHour: 2_200, feeBudgetStroopsPerHour: 100_000 });
    const app = createApp(f, { sellerTokens: ["tokA_r4_0123456789", "tokB_r4_0123456789"] });
    const post = async (tok: string) => {
      const req = requirements({ payTo: Keypair.random().publicKey() });
      const res = await app.request("/settle", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
        body: JSON.stringify({ paymentPayload: await signedPayload(req, { payerKp: Keypair.random() }), paymentRequirements: req }),
      });
      return (await res.json()) as { success: boolean; errorReason?: string };
    };
    expect((await post("tokA_r4_0123456789")).success).toBe(true);
    expect((await post("tokA_r4_0123456789")).success).toBe(true);
    expect((await post("tokA_r4_0123456789")).errorReason).toBe("seller_fee_budget_exhausted");
    expect((await post("tokB_r4_0123456789")).success).toBe(true);
  });
});

describe("M-r4-3 ambiguous sends are charged at the ceiling", () => {
  it("AMBIGUOUS and thrown sends count maxTransactionFeeStroops against the windows", async () => {
    class Amb extends MockChain {
      mode: "ambiguous" | "throw" = "ambiguous";
      override async send(tx: Transaction) {
        if (this.mode === "throw") throw new Error("socket hang up");
        return { status: "AMBIGUOUS", hash: Buffer.from(tx.hash()).toString("hex"), error: "x" };
      }
    }
    const chain = new Amb({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    const f = mk(chain, { maxTransactionFeeStroops: 20_000, feeBudgetStroopsPerHour: 100_000, feeBudgetPerSellerStroopsPerHour: 100_000 });
    const req = requirements();
    await f.settle(await signedPayload(req, { payerKp: Keypair.random() }), req);
    chain.mode = "throw";
    await f.settle(await signedPayload(req, { payerKp: Keypair.random() }), req);
    expect(f.usage().feeStroopsLastHour).toBe(40_000);
  });
});

describe("C-r4-1 (facilitator side) check() is bounded", () => {
  it("a stalled ledger lookup returns unexpected_verify_error within the deadline and claims nothing", async () => {
    const chain = new Moving();
    chain.stallLedgerMs = 2_000;
    const f = mk(chain, { settleDeadlineMs: 200 });
    const req = requirements();
    const p = await signedPayload(req);
    const t0 = Date.now();
    const r = await f.settle(p, req);
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(r).toMatchObject({ success: false, errorReason: "unexpected_verify_error", transaction: "" });
    chain.stallLedgerMs = 0;
    expect((await f.settle(p, req)).success).toBe(true);
  });
});
