import { Account, Keypair, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { ChainClient, SimulationResult, TransferEvent } from "../src/chain.js";
import { StellarFacilitator } from "../src/facilitator.js";
import { SqliteNonceStore } from "../src/nonce-store.js";
import { CURRENT_LEDGER, USDC_TESTNET, facilitator, requirements, signedPayload } from "./helpers.js";
import { MockChain } from "./mock-chain.js";

class Hanging extends MockChain {
  hangSend = false;
  hangWait = false;
  override async send(tx: Transaction) {
    if (this.hangSend) return new Promise<{ status: string; hash: string }>(() => undefined);
    return super.send(tx);
  }
  override async waitForTransaction(h: string, t: number) {
    if (this.hangWait) return new Promise<{ status: string }>(() => undefined);
    return super.waitForTransaction(h, t);
  }
}

const mk = (chain: ChainClient, extra: Partial<ConstructorParameters<typeof StellarFacilitator>[0]> = {}) =>
  new StellarFacilitator({
    network: "stellar:testnet",
    signer: facilitator,
    chain,
    nonceStore: new SqliteNonceStore(":memory:"),
    log: () => {},
    ...extra,
  });

describe("C-1 one payment, one claimant", () => {
  it("the same claim key reads the recorded success back; any other key is refused with the paying tx", async () => {
    const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    const f = mk(chain);
    const req = requirements();
    const p = await signedPayload(req);
    const first = await f.settle(p, req, { claimKey: "seller-claim-0001" });
    expect(first.success).toBe(true);
    const same = await f.settle(p, req, { claimKey: "seller-claim-0001" });
    expect(same).toMatchObject({ success: true, transaction: first.transaction });
    const other = await f.settle(p, req, { claimKey: "someone-else-0002" });
    expect(other).toMatchObject({ success: false, errorReason: "invalid_exact_stellar_payload_nonce_reused", transaction: first.transaction });
    const none = await f.settle(p, req);
    expect(none.errorReason).toBe("invalid_exact_stellar_payload_nonce_reused");
    expect(chain.sent).toHaveLength(1);
  });

  it("a claimant whose submission was never confirmed gets not_confirmed with the hash, then success once included", async () => {
    const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey(), finalStatus: "NOT_FOUND" });
    const f = mk(chain);
    const req = requirements();
    const p = await signedPayload(req);
    const r1 = await f.settle(p, req, { claimKey: "claim-abcdefgh" });
    expect(r1).toMatchObject({ success: false, errorReason: "settle_exact_stellar_transaction_not_confirmed" });
    expect(r1.transaction).toMatch(/^[0-9a-f]{64}$/);
    const r2 = await f.settle(p, req, { claimKey: "claim-abcdefgh" });
    expect(r2.errorReason).toBe("settle_exact_stellar_transaction_not_confirmed");
    (chain as unknown as { o: { finalStatus: string } }).o.finalStatus = "SUCCESS";
    const r3 = await f.settle(p, req, { claimKey: "claim-abcdefgh" });
    expect(r3).toMatchObject({ success: true, transaction: r1.transaction });
    expect(chain.sent).toHaveLength(1);
  });

  it("HTTP: Idempotency-Key is the claim key; a malformed key is ignored", async () => {
    const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    const app = createApp(mk(chain));
    const req = requirements();
    const p = await signedPayload(req);
    const post = (key?: string) =>
      app.request("/settle", {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
        body: JSON.stringify({ paymentPayload: p, paymentRequirements: req }),
      });
    const a = (await (await post("k-1234567890")).json()) as { success: boolean };
    const b = (await (await post("k-1234567890")).json()) as { success: boolean };
    const c = (await (await post("bad key!")).json()) as { success: boolean; errorReason: string };
    expect(a.success && b.success).toBe(true);
    expect(c).toMatchObject({ success: false, errorReason: "invalid_exact_stellar_payload_nonce_reused" });
  });
});

describe("I-1r2 a hung RPC call does not hold the signer", () => {
  it("send hangs: the deadline frees the lock, the claim is kept, the next buyer settles", async () => {
    const chain = new Hanging({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    const f = mk(chain, { settleDeadlineMs: 300 });
    const req = requirements();
    const pa = await signedPayload(req, { payerKp: Keypair.random() });
    const pb = await signedPayload(req, { payerKp: Keypair.random() });
    chain.hangSend = true;
    const t0 = Date.now();
    const ra = await f.settle(pa, req);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(ra).toMatchObject({ success: false, errorReason: "unexpected_settle_error" });
    expect(ra.transaction).toMatch(/^[0-9a-f]{64}$/);
    chain.hangSend = false;
    const rb = await f.settle(pb, req);
    expect(rb.success).toBe(true);
    expect((await f.settle(pa, req)).errorReason).toBe("invalid_exact_stellar_payload_nonce_reused");
  });

  it("confirmation hangs after submit: not_confirmed with hash, lock freed", async () => {
    const chain = new Hanging({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    const f = mk(chain, { settleDeadlineMs: 300 });
    const req = requirements();
    const pa = await signedPayload(req, { payerKp: Keypair.random() });
    chain.hangWait = true;
    const ra = await f.settle(pa, req);
    expect(ra).toMatchObject({ success: false, errorReason: "settle_exact_stellar_transaction_not_confirmed" });
    expect(ra.transaction).toMatch(/^[0-9a-f]{64}$/);
    chain.hangWait = false;
    expect((await f.settle(await signedPayload(req, { payerKp: Keypair.random() }), req)).success).toBe(true);
  });

  it("simulation hangs before any claim: the buyer's entry stays usable", async () => {
    class SimHang extends MockChain {
      hang = true;
      override async simulate(tx: Transaction, e: TransferEvent): Promise<SimulationResult> {
        if (this.hang) return new Promise<SimulationResult>(() => undefined);
        return super.simulate(tx, e);
      }
    }
    const chain = new SimHang({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    const f = mk(chain, { settleDeadlineMs: 300 });
    const req = requirements();
    const p = await signedPayload(req);
    const r1 = await f.settle(p, req);
    expect(r1).toMatchObject({ success: false, errorReason: "unexpected_settle_error", transaction: "" });
    chain.hang = false;
    expect((await f.settle(p, req)).success).toBe(true);
  });
});

describe("M-r2-3 allowlist validation", () => {
  it("rejects non-strkey entries and blanks at construction", () => {
    const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    expect(() => mk(chain, { allowedAssets: [USDC_TESTNET.toLowerCase()] })).toThrow(/strkey/);
    expect(() => mk(chain, { allowedAssets: ["", "  "] })).toThrow();
    expect([...mk(chain, { allowedAssets: [` ${USDC_TESTNET} `, ""] }).allowedAssets]).toEqual([USDC_TESTNET]);
  });

  it("refuses when the payload's accepted asset differs from the (allowed) requirements asset", async () => {
    const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    const f = mk(chain);
    const req = requirements();
    const p = { ...(await signedPayload(req)), accepted: { ...req, asset: USDC_TESTNET.toLowerCase() } };
    expect(await f.verify(p, req)).toMatchObject({ isValid: false, invalidReason: "invalid_exact_stellar_payload_asset_not_allowed" });
  });
});

describe("ledger-faithful: thrown send keeps the claim, the next buyer proceeds", () => {
  class Ledger implements ChainClient {
    seq = 10n;
    throwOnce = true;
    async getLatestLedger() {
      return CURRENT_LEDGER;
    }
    async estimatedLedgerSeconds() {
      return 5;
    }
    async getAccount(a: string) {
      return new Account(a, this.seq.toString());
    }
    async simulate(_t: Transaction, e: TransferEvent): Promise<SimulationResult> {
      return { ok: true, minResourceFee: "1000", transfers: [e], assemble: (t) => t };
    }
    async send(tx: Transaction) {
      if (this.throwOnce) {
        this.throwOnce = false;
        throw new Error("socket hang up");
      }
      return { status: "PENDING", hash: Buffer.from(tx.hash()).toString("hex") };
    }
    async waitForTransaction() {
      this.seq++;
      return { status: "SUCCESS" };
    }
  }
  it("A: unexpected_settle_error with hash; A again: nonce_reused; B: success", async () => {
    const f = mk(new Ledger());
    const req = requirements();
    const pa = await signedPayload(req, { payerKp: Keypair.random() });
    const pb = await signedPayload(req, { payerKp: Keypair.random() });
    expect((await f.settle(pa, req)).errorReason).toBe("unexpected_settle_error");
    expect((await f.settle(pa, req)).errorReason).toBe("invalid_exact_stellar_payload_nonce_reused");
    expect((await f.settle(pb, req)).success).toBe(true);
  });
});
