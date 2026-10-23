import { Keypair, Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { verifyStatic, type StaticContext } from "../src/verify.js";
import { SqliteNonceStore } from "../src/nonce-store.js";
import {
  CURRENT_LEDGER,
  OTHER_ASSET,
  facilitator,
  payer,
  requirements,
  signedPayload,
} from "./helpers.js";

function ctx(overrides: Partial<StaticContext> = {}): StaticContext {
  return {
    networkPassphrase: Networks.TESTNET,
    facilitatorAddresses: new Set([facilitator.publicKey()]),
    currentLedger: CURRENT_LEDGER,
    estimatedLedgerSeconds: 5,
    nonceStore: new SqliteNonceStore(":memory:"),
    ...overrides,
  };
}

describe("verifyStatic (no network)", () => {
  it("accepts a correctly signed transfer to the seller for the exact amount", async () => {
    const req = requirements();
    const res = verifyStatic(await signedPayload(req), req, ctx());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payer).toBe(payer.publicKey());
      expect(typeof res.nonce).toBe("string");
    }
  });

  it("rejects the wrong amount", async () => {
    const req = requirements();
    const res = verifyStatic(await signedPayload(req, { amount: "99999" }), req, ctx());
    expect(res).toMatchObject({ ok: false, reason: "invalid_exact_stellar_payload_wrong_amount" });
  });

  it("rejects the wrong destination", async () => {
    const req = requirements();
    const res = verifyStatic(
      await signedPayload(req, { payTo: Keypair.random().publicKey() }),
      req,
      ctx(),
    );
    expect(res).toMatchObject({
      ok: false,
      reason: "invalid_exact_stellar_payload_wrong_recipient",
    });
  });

  it("rejects an expired auth entry", async () => {
    const req = requirements();
    const res = verifyStatic(
      await signedPayload(req, { validUntilLedgerSeq: CURRENT_LEDGER }),
      req,
      ctx(),
    );
    expect(res).toMatchObject({ ok: false, reason: "invalid_exact_stellar_signature_expired" });
  });

  it("rejects an auth entry that expires beyond maxTimeoutSeconds", async () => {
    const req = requirements({ maxTimeoutSeconds: 60 });
    const res = verifyStatic(
      await signedPayload(req, { validUntilLedgerSeq: CURRENT_LEDGER + 1000 }),
      req,
      ctx(),
    );
    expect(res).toMatchObject({
      ok: false,
      reason: "invalid_exact_stellar_signature_expiration_too_far",
    });
  });

  it("rejects a replayed nonce", async () => {
    const req = requirements();
    const c = ctx();
    const payload = await signedPayload(req);
    const first = verifyStatic(payload, req, c);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    c.nonceStore.consume(req.network, first.payer, first.nonce, "deadbeef");
    const second = verifyStatic(payload, req, c);
    expect(second).toMatchObject({ ok: false, reason: "invalid_exact_stellar_payload_nonce_reused" });
  });

  it("rejects the wrong asset contract", async () => {
    const req = requirements();
    const res = verifyStatic(await signedPayload(req, { asset: OTHER_ASSET }), req, ctx());
    expect(res).toMatchObject({ ok: false, reason: "invalid_exact_stellar_payload_wrong_asset" });
  });

  it("rejects a tampered signature (signed by a key other than the payer)", async () => {
    const req = requirements();
    const res = verifyStatic(await signedPayload(req, { signerKp: Keypair.random() }), req, ctx());
    expect(res).toMatchObject({ ok: false, reason: "invalid_exact_stellar_payload_bad_signature" });
  });

  it("rejects a signature made for a different network", async () => {
    const req = requirements();
    const payload = await signedPayload(req);
    const res = verifyStatic(payload, req, ctx({ networkPassphrase: Networks.PUBLIC }));
    expect(res.ok).toBe(false);
  });

  it("rejects when the facilitator is the payer", async () => {
    const req = requirements();
    const res = verifyStatic(
      await signedPayload(req, {
        payerKp: facilitator,
        sourceAccount: Keypair.random().publicKey(),
      }),
      req,
      ctx(),
    );
    expect(res).toMatchObject({
      ok: false,
      reason: "invalid_exact_stellar_payload_facilitator_is_payer",
    });
  });

  it("rejects when the facilitator is the transaction source", async () => {
    const req = requirements();
    const res = verifyStatic(
      await signedPayload(req, { sourceAccount: facilitator.publicKey() }),
      req,
      ctx(),
    );
    expect(res).toMatchObject({
      ok: false,
      reason: "invalid_exact_stellar_payload_unsafe_tx_or_op_source",
    });
  });

  it("rejects an unsupported x402 version", async () => {
    const req = requirements();
    const payload = { ...(await signedPayload(req)), x402Version: 1 };
    expect(verifyStatic(payload, req, ctx())).toMatchObject({
      ok: false,
      reason: "invalid_x402_version",
    });
  });

  it("rejects a scheme other than exact", async () => {
    const req = requirements();
    const payload = await signedPayload(req);
    expect(verifyStatic(payload, { ...req, scheme: "upto" }, ctx())).toMatchObject({
      ok: false,
      reason: "unsupported_scheme",
    });
  });

  it("rejects a network mismatch between accepted and requirements", async () => {
    const req = requirements();
    const payload = await signedPayload(req);
    expect(verifyStatic(payload, { ...req, network: "stellar:pubnet" }, ctx())).toMatchObject({
      ok: false,
      reason: "network_mismatch",
    });
  });

  it("rejects malformed transaction XDR", () => {
    const req = requirements();
    const payload = { x402Version: 2, accepted: req, payload: { transaction: "not-xdr" } };
    expect(verifyStatic(payload, req, ctx())).toMatchObject({
      ok: false,
      reason: "invalid_exact_stellar_payload_malformed",
    });
  });

  it("rejects a transaction with no auth entries", async () => {
    const req = requirements();
    const payload = await signedPayload(req, { signerKp: null });
    expect(verifyStatic(payload, req, ctx())).toMatchObject({
      ok: false,
      reason: "invalid_exact_stellar_payload_no_auth_entries",
    });
  });
});
