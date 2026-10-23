import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { StellarFacilitator } from "../src/facilitator.js";
import { SqliteNonceStore } from "../src/nonce-store.js";
import { SupportedResponseSchema } from "../src/types.js";
import { CURRENT_LEDGER, facilitator, payer, requirements, signedPayload } from "./helpers.js";
import { MockChain, type MockChainOptions } from "./mock-chain.js";

function make(opts: Partial<MockChainOptions> = {}, fac: Partial<{ maxTransactionFeeStroops: number }> = {}) {
  const chain = new MockChain({
    currentLedger: CURRENT_LEDGER,
    facilitatorAddress: facilitator.publicKey(),
    ...opts,
  });
  const f = new StellarFacilitator({
    network: "stellar:testnet",
    signer: facilitator,
    chain,
    nonceStore: new SqliteNonceStore(":memory:"),
    ...fac,
  });
  return { chain, f };
}

describe("StellarFacilitator.verify (simulation through a mock chain)", () => {
  it("is valid when simulation reports exactly the expected transfer", async () => {
    const { f } = make();
    const req = requirements();
    const res = await f.verify(await signedPayload(req), req);
    expect(res).toEqual({ isValid: true, payer: payer.publicKey() });
  });

  it("rejects when simulation shows a different transfer amount", async () => {
    const req = requirements();
    const { f } = make({
      transfers: [{ asset: req.asset, from: payer.publicKey(), to: req.payTo, amount: 1n }],
    });
    const res = await f.verify(await signedPayload(req), req);
    expect(res).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_event_wrong_amount",
    });
  });

  it("rejects when simulation shows more than one balance change", async () => {
    const req = requirements();
    const t = { asset: req.asset, from: payer.publicKey(), to: req.payTo, amount: 100000n };
    const { f } = make({ transfers: [t, { ...t, to: facilitator.publicKey() }] });
    const res = await f.verify(await signedPayload(req), req);
    expect(res).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_multiple_transfers",
    });
  });

  it("rejects when the simulation fails", async () => {
    const { f } = make({ simulationError: "HostError: trustline missing" });
    const req = requirements();
    const res = await f.verify(await signedPayload(req), req);
    expect(res).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_simulation_failed",
    });
  });

  it("rejects when the simulation-derived fee exceeds the ceiling", async () => {
    const { f } = make({ minResourceFee: "60000" }, { maxTransactionFeeStroops: 50_000 });
    const req = requirements();
    const res = await f.verify(await signedPayload(req), req);
    expect(res).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_fee_exceeds_maximum",
    });
  });

  it("never simulates a payload that fails static checks", async () => {
    const { chain, f } = make({ simulationError: "should not be reached" });
    const req = requirements();
    const res = await f.verify(await signedPayload(req, { amount: "1" }), req);
    expect(res.invalidReason).toBe("invalid_exact_stellar_payload_wrong_amount");
    expect(chain.sent).toHaveLength(0);
  });
});

describe("StellarFacilitator.settle", () => {
  it("rebuilds with the facilitator as source, signs, submits and returns the hash", async () => {
    const { chain, f } = make();
    const req = requirements();
    const res = await f.settle(await signedPayload(req), req);
    expect(res.success).toBe(true);
    expect(res.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(res.network).toBe("stellar:testnet");
    expect(res.payer).toBe(payer.publicKey());
    expect(chain.sent).toHaveLength(1);
    const sent = chain.sent[0]!;
    expect(sent.source).toBe(facilitator.publicKey());
    expect(sent.signatures).toHaveLength(1);
    expect(sent.operations[0]?.type).toBe("invokeHostFunction");
  });

  it("refuses to settle the same signed payload twice", async () => {
    const { f } = make();
    const req = requirements();
    const payload = await signedPayload(req);
    const first = await f.settle(payload, req);
    expect(first.success).toBe(true);
    const again = await f.settle(payload, req);
    expect(again).toMatchObject({
      success: false,
      errorReason: "invalid_exact_stellar_payload_nonce_reused",
      transaction: first.transaction,
    });
    expect(await f.verify(payload, req)).toMatchObject({ isValid: false });
  });

  it("releases the nonce when the network rejects the submission outright", async () => {
    const { f } = make({ sendStatus: "ERROR" });
    const req = requirements();
    const payload = await signedPayload(req);
    const res = await f.settle(payload, req);
    expect(res).toMatchObject({
      success: false,
      errorReason: "settle_exact_stellar_transaction_submission_failed",
    });
    expect(await f.verify(payload, req)).toMatchObject({ isValid: true });
  });

  it("reports a failed transaction with its hash", async () => {
    const { f } = make({ finalStatus: "FAILED" });
    const req = requirements();
    const res = await f.settle(await signedPayload(req), req);
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe("settle_exact_stellar_transaction_failed");
    expect(res.transaction).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the static failure reason without touching the chain", async () => {
    const { chain, f } = make();
    const req = requirements();
    const res = await f.settle(await signedPayload(req, { payTo: Keypair.random().publicKey() }), req);
    expect(res).toMatchObject({
      success: false,
      errorReason: "invalid_exact_stellar_payload_wrong_recipient",
    });
    expect(chain.sent).toHaveLength(0);
  });
});

describe("StellarFacilitator.supported", () => {
  it("advertises exact on stellar:testnet with fee sponsorship and the signer", () => {
    const { f } = make();
    const s = f.supported();
    expect(SupportedResponseSchema.parse(s)).toBeTruthy();
    expect(s.kinds).toEqual([
      {
        x402Version: 2,
        scheme: "exact",
        network: "stellar:testnet",
        extra: { areFeesSponsored: true, assets: ["CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"] },
      },
    ]);
    expect(s.signers["stellar:*"]).toEqual([facilitator.publicKey()]);
  });
});
