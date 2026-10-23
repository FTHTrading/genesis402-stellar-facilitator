import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { StellarFacilitator } from "../src/facilitator.js";
import { SqliteNonceStore } from "../src/nonce-store.js";
import { CURRENT_LEDGER, facilitator, requirements, signedPayload } from "./helpers.js";
import { MockChain } from "./mock-chain.js";

const mk = (extra: Partial<ConstructorParameters<typeof StellarFacilitator>[0]> = {}) => {
  const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey(), minResourceFee: "1000" });
  const f = new StellarFacilitator({ network: "stellar:testnet", signer: facilitator, chain, nonceStore: new SqliteNonceStore(":memory:"), log: () => {}, ...extra });
  return { chain, f };
};

describe("DoS.6 fee-drain guard", () => {
  it("refuses settlement once the hour's fee budget would be exceeded; the budget refills as the window slides", async () => {
    let t = 1_700_000_000_000;
    // Each settlement costs 1000 + 100 stroops; budget allows two.
    const { chain, f } = mk({ feeBudgetStroopsPerHour: 2_300, feeBudgetPerSellerStroopsPerHour: 2_300, now: () => t });
    const req = requirements();
    expect((await f.settle(await signedPayload(req, { payerKp: Keypair.random() }), req)).success).toBe(true);
    expect((await f.settle(await signedPayload(req, { payerKp: Keypair.random() }), req)).success).toBe(true);
    const third = await signedPayload(req, { payerKp: Keypair.random() });
    expect(await f.settle(third, req)).toMatchObject({ success: false, errorReason: "fee_budget_exhausted", transaction: "" });
    expect(chain.sent).toHaveLength(2);
    // The refused entry was never claimed: it is still valid.
    expect(await f.verify(third, req)).toMatchObject({ isValid: true });
    t += 3_600_001;
    expect((await f.settle(third, req)).success).toBe(true);
  });

  it("caps settlements per seller (payTo) per hour, independent of the fee budget", async () => {
    const { f } = mk({ maxSettlesPerSellerPerHour: 2 });
    const req = requirements();
    expect((await f.settle(await signedPayload(req, { payerKp: Keypair.random() }), req)).success).toBe(true);
    expect((await f.settle(await signedPayload(req, { payerKp: Keypair.random() }), req)).success).toBe(true);
    expect(await f.settle(await signedPayload(req, { payerKp: Keypair.random() }), req)).toMatchObject({ success: false, errorReason: "seller_rate_limited" });
    const other = requirements({ payTo: Keypair.random().publicKey() });
    expect((await f.settle(await signedPayload(other, { payerKp: Keypair.random() }), other)).success).toBe(true);
  });

  it("HTTP /settle answers 429 with Retry-After when the guard refuses; /health shows usage", async () => {
    const { f } = mk({ feeBudgetStroopsPerHour: 1_000 });
    const app = createApp(f);
    const req = requirements();
    const res = await app.request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: await signedPayload(req), paymentRequirements: req }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(await res.json()).toMatchObject({ success: false, errorReason: "fee_budget_exhausted" });
    const health = (await (await app.request("/health")).json()) as { feeBudgetStroopsPerHour: number; feeStroopsLastHour: number };
    expect(health).toMatchObject({ feeBudgetStroopsPerHour: 1_000, feeStroopsLastHour: 0 });
  });

  it("defaults: 5,000,000 stroops per hour and 600 settlements per seller", () => {
    const { f } = mk();
    expect(f.feeBudgetStroopsPerHour).toBe(5_000_000);
    expect(f.maxSettlesPerSellerPerHour).toBe(600);
  });
});

describe("Elevation.4 optional seller authentication", () => {
  const body = async () => {
    const req = requirements();
    return JSON.stringify({ paymentPayload: await signedPayload(req, { payerKp: Keypair.random() }), paymentRequirements: req });
  };

  it("open by default: /supported advertises sellerAuth=open and /verify needs no token", async () => {
    const app = createApp(mk().f);
    const sup = (await (await app.request("/supported")).json()) as { kinds: Array<{ extra: { sellerAuth: string } }> };
    expect(sup.kinds[0]?.extra.sellerAuth).toBe("open");
    const res = await app.request("/verify", { method: "POST", headers: { "content-type": "application/json" }, body: await body() });
    expect(res.status).toBe(200);
  });

  it("with SELLER_TOKENS: /verify and /settle require a matching bearer token; /supported says bearer", async () => {
    const app = createApp(mk().f, { sellerTokens: ["tok-A-0123456789", " tok-B-9876543210 ", ""] });
    const sup = (await (await app.request("/supported")).json()) as { kinds: Array<{ extra: { sellerAuth: string } }> };
    expect(sup.kinds[0]?.extra.sellerAuth).toBe("bearer");
    for (const path of ["/verify", "/settle"]) {
      const anon = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: await body() });
      expect(anon.status).toBe(401);
      expect(anon.headers.get("www-authenticate")).toBe("Bearer");
      expect(await anon.json()).toEqual({ error: "unauthorized" });
      const wrong = await app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok-A-0123456780" }, body: await body() });
      expect(wrong.status).toBe(401);
      const ok = await app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok-B-9876543210" }, body: await body() });
      expect(ok.status).toBe(200);
    }
  });

  it("reads and health stay open in bearer mode", async () => {
    const app = createApp(mk().f, { sellerTokens: ["tok-A-0123456789"] });
    expect((await app.request("/supported")).status).toBe(200);
    expect((await app.request("/health")).status).toBe(200);
  });
});
