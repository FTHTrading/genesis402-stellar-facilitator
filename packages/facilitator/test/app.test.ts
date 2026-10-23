import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { StellarFacilitator } from "../src/facilitator.js";
import { SqliteNonceStore } from "../src/nonce-store.js";
import { SupportedResponseSchema } from "../src/types.js";
import { CURRENT_LEDGER, facilitator, payer, requirements, signedPayload } from "./helpers.js";
import { MockChain } from "./mock-chain.js";

function app() {
  const chain = new MockChain({
    currentLedger: CURRENT_LEDGER,
    facilitatorAddress: facilitator.publicKey(),
  });
  const f = new StellarFacilitator({
    network: "stellar:testnet",
    signer: facilitator,
    chain,
    nonceStore: new SqliteNonceStore(":memory:"),
  });
  return createApp(f);
}

describe("facilitator HTTP API", () => {
  it("GET /supported returns the x402 v2 supported-kinds document", async () => {
    const res = await app().request("/supported");
    expect(res.status).toBe(200);
    const body = SupportedResponseSchema.parse(await res.json());
    expect(body.kinds[0]?.network).toBe("stellar:testnet");
  });

  it("GET /health reports the network and signer", async () => {
    const res = await app().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "ok",
      network: "stellar:testnet",
      signer: facilitator.publicKey(),
    });
  });

  it("POST /verify rejects a malformed body with 400", async () => {
    const res = await app().request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: {} }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("POST /verify returns isValid for a good payload", async () => {
    const req = requirements();
    const res = await app().request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: await signedPayload(req),
        paymentRequirements: req,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isValid: true, payer: payer.publicKey() });
  });

  it("POST /verify returns isValid=false with a reason for a bad payload (HTTP 200)", async () => {
    const req = requirements();
    const res = await app().request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentPayload: await signedPayload(req, { amount: "5" }),
        paymentRequirements: req,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_wrong_amount",
    });
  });

  it("POST /settle returns the settlement receipt", async () => {
    const req = requirements();
    const res = await app().request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: await signedPayload(req), paymentRequirements: req }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; transaction: string; network: string };
    expect(body.success).toBe(true);
    expect(body.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(body.network).toBe("stellar:testnet");
  });
});
