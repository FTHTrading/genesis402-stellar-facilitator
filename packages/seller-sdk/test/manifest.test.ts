import { describe, expect, it } from "vitest";
import { ManifestSchema, buildManifest, createPaywall } from "../src/index.js";

const SELLER = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";

describe("buildManifest (/.well-known/x402)", () => {
  it("emits an x402 v2 manifest with Bazaar-style service entries that validates", () => {
    const pw = createPaywall({ facilitatorUrl: "http://f.local", payTo: SELLER, network: "stellar:testnet" });
    const manifest = buildManifest({
      provider: { name: "Reference Seller", operator: "UnyKorn LLC", origin: "https://seller.example", contact: "kevan@unykorn.org" },
      paywall: pw,
      services: [
        {
          name: "weather",
          endpoint: "https://seller.example/weather",
          method: "GET",
          title: "Current weather for a city",
          what_you_get: "Temperature and conditions as JSON",
          price_usd: "0.01",
          output_schema: { type: "object", properties: { tempC: { type: "number" } } },
        },
      ],
      free_endpoints: ["/health", "/.well-known/x402"],
    });
    const parsed = ManifestSchema.parse(manifest);
    expect(parsed.x402Version).toBe(2);
    expect(parsed.services[0]?.accepts[0]).toMatchObject({ network: "stellar:testnet", amount: "100000", payTo: SELLER });
    expect(parsed.accepts[0]?.network).toBe("stellar:testnet");
    expect(parsed.services[0]?.price_usd).toBe("0.01");
    expect(typeof parsed.generated_at).toBe("string");
  });

  it("rejects a manifest whose service has no accepts entry", () => {
    expect(() =>
      ManifestSchema.parse({
        x402Version: 2,
        provider: { name: "x", operator: "y", origin: "https://z", contact: "a@b.c" },
        status: "live",
        services: [{ name: "n", endpoint: "https://z/n", method: "GET", title: "t", what_you_get: "w", price_usd: "0.01", accepts: [] }],
        accepts: [],
        generated_at: new Date().toISOString(),
      }),
    ).toThrow();
  });
});
