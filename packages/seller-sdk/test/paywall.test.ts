import { describe, expect, it } from "vitest";
import { createPaywall, decodeHeader, encodeHeader, usdToAtomic } from "../src/index.js";
import { PaymentRequiredSchema } from "../src/x402.js";

const SELLER = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";
const PAYER = "GAPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAW";

interface Call {
  path: string;
  body: unknown;
}

function mockFacilitator(opts: { valid?: boolean; success?: boolean; reason?: string } = {}) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === "/verify") {
      return Response.json(
        opts.valid === false
          ? { isValid: false, invalidReason: opts.reason ?? "invalid_exact_stellar_payload_wrong_amount" }
          : { isValid: true, payer: PAYER },
      );
    }
    if (path === "/settle") {
      return Response.json(
        opts.success === false
          ? { success: false, errorReason: "settle_exact_stellar_transaction_failed", transaction: "ab".repeat(32), network: "stellar:testnet" }
          : { success: true, transaction: "cd".repeat(32), network: "stellar:testnet", payer: PAYER },
      );
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, fetchImpl };
}

function paywall(fetchImpl: typeof fetch) {
  return createPaywall({
    facilitatorUrl: "http://facilitator.local",
    payTo: SELLER,
    network: "stellar:testnet",
    fetch: fetchImpl,
  });
}

const resource = { url: "https://seller.example/weather", description: "Weather", mimeType: "application/json" };

describe("usdToAtomic", () => {
  it("converts USD decimal strings to 7-decimal atomic units exactly", () => {
    expect(usdToAtomic("0.01")).toBe("100000");
    expect(usdToAtomic("1")).toBe("10000000");
    expect(usdToAtomic("0.0000001")).toBe("1");
    expect(usdToAtomic("12.5")).toBe("125000000");
  });
  it("rejects more precision than the asset carries and non-numeric input", () => {
    expect(() => usdToAtomic("0.00000001")).toThrow();
    expect(() => usdToAtomic("abc")).toThrow();
    expect(() => usdToAtomic("-1")).toThrow();
  });
});

describe("createPaywall", () => {
  it("answers an unpaid request with a 402 PaymentRequired in body and PAYMENT-REQUIRED header", async () => {
    const { fetchImpl } = mockFacilitator();
    const pw = paywall(fetchImpl);
    const res = await pw.handle({ price: "0.01", resource, headers: new Headers() });
    expect(res.kind).toBe("payment_required");
    if (res.kind !== "payment_required") return;
    expect(res.status).toBe(402);
    const body = PaymentRequiredSchema.parse(res.body);
    expect(body.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "stellar:testnet",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      amount: "100000",
      payTo: SELLER,
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
    });
    expect(body.resource).toEqual(resource);
    expect(decodeHeader(res.headers["PAYMENT-REQUIRED"]!)).toEqual(body);
  });

  it("verifies then settles a presented payment and exposes PAYMENT-RESPONSE", async () => {
    const { calls, fetchImpl } = mockFacilitator();
    const pw = paywall(fetchImpl);
    const quote = await pw.handle({ price: "0.01", resource, headers: new Headers() });
    if (quote.kind !== "payment_required") throw new Error("expected 402");
    const payload = {
      x402Version: 2,
      resource,
      accepted: quote.body.accepts[0],
      payload: { transaction: "AAAA" },
    };
    const headers = new Headers({ "PAYMENT-SIGNATURE": encodeHeader(payload) });
    const res = await pw.handle({ price: "0.01", resource, headers });
    expect(res.kind).toBe("paid");
    if (res.kind !== "paid") return;
    expect(res.settlement).toMatchObject({ success: true, transaction: "cd".repeat(32), payer: PAYER });
    expect(decodeHeader(res.headers["PAYMENT-RESPONSE"]!)).toEqual(res.settlement);
    expect(calls.map((c) => c.path)).toEqual(["/verify", "/settle"]);
    expect(calls[0]?.body).toMatchObject({
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: quote.body.accepts[0],
    });
  });

  it("re-issues a 402 with the facilitator's reason when verification fails", async () => {
    const { calls, fetchImpl } = mockFacilitator({ valid: false, reason: "invalid_exact_stellar_payload_wrong_recipient" });
    const pw = paywall(fetchImpl);
    const headers = new Headers({
      "PAYMENT-SIGNATURE": encodeHeader({ x402Version: 2, accepted: pw.requirements("0.01"), payload: { transaction: "AAAA" } }),
    });
    const res = await pw.handle({ price: "0.01", resource, headers });
    expect(res.kind).toBe("payment_required");
    if (res.kind !== "payment_required") return;
    expect(res.body.error).toBe("invalid_exact_stellar_payload_wrong_recipient");
    expect(calls.map((c) => c.path)).toEqual(["/verify"]);
  });

  it("reports a settlement failure without delivering", async () => {
    const { fetchImpl } = mockFacilitator({ success: false });
    const pw = paywall(fetchImpl);
    const headers = new Headers({
      "PAYMENT-SIGNATURE": encodeHeader({ x402Version: 2, accepted: pw.requirements("0.01"), payload: { transaction: "AAAA" } }),
    });
    const res = await pw.handle({ price: "0.01", resource, headers });
    expect(res.kind).toBe("payment_required");
    if (res.kind !== "payment_required") return;
    expect(res.body.error).toBe("settle_exact_stellar_transaction_failed");
  });

  it("treats an undecodable PAYMENT-SIGNATURE as unpaid with an error", async () => {
    const { calls, fetchImpl } = mockFacilitator();
    const pw = paywall(fetchImpl);
    const res = await pw.handle({ price: "0.01", resource, headers: new Headers({ "PAYMENT-SIGNATURE": "%%%" }) });
    expect(res.kind).toBe("payment_required");
    if (res.kind !== "payment_required") return;
    expect(res.body.error).toBe("payment_signature_malformed");
    expect(calls).toHaveLength(0);
  });

  it("refuses a payment whose accepted terms differ from the quote", async () => {
    const { calls, fetchImpl } = mockFacilitator();
    const pw = paywall(fetchImpl);
    const accepted = { ...pw.requirements("0.01"), payTo: PAYER };
    const headers = new Headers({
      "PAYMENT-SIGNATURE": encodeHeader({ x402Version: 2, accepted, payload: { transaction: "AAAA" } }),
    });
    const res = await pw.handle({ price: "0.01", resource, headers });
    expect(res.kind).toBe("payment_required");
    if (res.kind !== "payment_required") return;
    expect(res.body.error).toBe("accepted_terms_mismatch");
    expect(calls).toHaveLength(0);
  });
});
