import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createPaywall, encodeHeader, honoPaywall } from "../src/index.js";

const SELLER = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";

describe("honoPaywall middleware", () => {
  it("gates a route: 402 without payment, 200 with PAYMENT-RESPONSE after settlement", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(typeof input === "string" ? input : (input as Request).url).pathname;
      if (path === "/verify") return Response.json({ isValid: true, payer: "GPAYER" });
      return Response.json({ success: true, transaction: "ef".repeat(32), network: "stellar:testnet", payer: "GPAYER" });
    };
    const pw = createPaywall({ facilitatorUrl: "http://f.local", payTo: SELLER, network: "stellar:testnet", fetch: fetchImpl });
    const app = new Hono();
    app.get("/weather", honoPaywall(pw, { price: "0.01", description: "Weather" }), (c) => c.json({ tempC: 21 }));

    const unpaid = await app.request("http://seller.example/weather");
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    const quote = (await unpaid.json()) as { accepts: unknown[] };

    const paid = await app.request("http://seller.example/weather", {
      headers: {
        "PAYMENT-SIGNATURE": encodeHeader({
          x402Version: 2,
          resource: { url: "http://seller.example/weather" },
          accepted: quote.accepts[0],
          payload: { transaction: "AAAA" },
        }),
      },
    });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ tempC: 21 });
    expect(paid.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
  });
});
