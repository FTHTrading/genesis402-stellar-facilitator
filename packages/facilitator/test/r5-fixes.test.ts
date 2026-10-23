import { Keypair, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { StellarFacilitator } from "../src/facilitator.js";
import { SqliteNonceStore } from "../src/nonce-store.js";
import type { PaymentPayload } from "../src/types.js";
import { CURRENT_LEDGER, facilitator, requirements, signedPayload } from "./helpers.js";
import { MockChain } from "./mock-chain.js";

const mk = (chain: MockChain) =>
  new StellarFacilitator({ network: "stellar:testnet", signer: facilitator, chain, nonceStore: new SqliteNonceStore(":memory:"), log: () => {} });

/** Same (payer, nonce), first signature byte flipped: a replayed header with a damaged signature. */
function corrupt(p: PaymentPayload): PaymentPayload {
  const env = xdr.TransactionEnvelope.fromXDR(p.payload.transaction, "base64") as unknown as {
    v1: { tx: { operations: Array<{ body: { invokeHostFunctionOp: { auth: Array<{ credentials: unknown }> } } }> } };
    toXDR: (f: "base64") => string;
  };
  const visit = (o: unknown): void => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (v instanceof Uint8Array) {
        if (v.length === 64) (o as Record<string, unknown>)[k] = Uint8Array.from(v, (x, i) => (i === 0 ? x ^ 1 : x));
      } else visit(v);
    }
  };
  visit(env.v1.tx.operations[0]!.body.invokeHostFunctionOp.auth[0]!.credentials);
  const out = env.toXDR("base64");
  if (out === p.payload.transaction) throw new Error("nothing corrupted");
  return { ...p, payload: { transaction: out } };
}

describe("M-r5-7 signature before the consumed-nonce answer", () => {
  it("a consumed nonce under a damaged signature is bad_signature, the genuine replay is nonce_reused, and a claimant past the ledger still reads its record", async () => {
    const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    const f = mk(chain);
    const req = requirements();
    const p = await signedPayload(req, { payerKp: Keypair.random(), validUntilLedgerSeq: CURRENT_LEDGER + 3 });
    const first = await f.settle(p, req, { claimKey: "claimant" });
    expect(first.success).toBe(true);

    expect((await f.verify(corrupt(p), req)).invalidReason).toBe("invalid_exact_stellar_payload_bad_signature");
    expect((await f.settle(corrupt(p), req, { claimKey: "claimant" })).errorReason).toBe("invalid_exact_stellar_payload_bad_signature");
    expect((await f.verify(p, req)).invalidReason).toBe("invalid_exact_stellar_payload_nonce_reused");

    (chain as unknown as { o: { currentLedger: number } }).o.currentLedger = CURRENT_LEDGER + 50; // entry expired on chain
    expect((await f.verify(corrupt(p), req)).invalidReason).toBe("invalid_exact_stellar_payload_bad_signature");
    const again = await f.settle(p, req, { claimKey: "claimant" });
    expect(again).toMatchObject({ success: true, transaction: first.transaction });
    const stranger = await f.settle(p, req, { claimKey: "stranger" });
    expect(stranger).toMatchObject({ success: false, errorReason: "invalid_exact_stellar_payload_nonce_reused" });
  });
});
