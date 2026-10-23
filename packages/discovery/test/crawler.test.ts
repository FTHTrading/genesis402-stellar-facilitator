import { describe, expect, it } from "vitest";
import { crawlManifest } from "../src/crawler.js";
import { ResourceRecordSchema } from "../src/schema.js";
import { ORIGIN, SELLER, mockSeller } from "./mock-seller.js";

describe("crawlManifest", () => {
  it("lists a resource only after fetching a real 402 quote from it", async () => {
    const seller = mockSeller();
    const result = await crawlManifest(seller.manifestUrl, { fetch: seller.fetchImpl });
    expect(result.listed.map((r) => r.name).sort()).toEqual(["quote", "weather"]);
    expect(result.skipped).toEqual([]);
    const weather = result.listed.find((r) => r.name === "weather")!;
    ResourceRecordSchema.parse(weather);
    expect(weather).toMatchObject({
      seller_origin: ORIGIN,
      endpoint: `${ORIGIN}/weather`,
      method: "GET",
      network: "stellar:testnet",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      amount: "100000",
      payTo: SELLER,
      price_usd: "0.01",
      category: "data",
    });
    expect(Date.parse(weather.quote_verified_at)).toBeGreaterThan(0);
  });

  it("skips a service that answers 200 instead of 402", async () => {
    const seller = mockSeller({ overrides: { weather: "free" } });
    const result = await crawlManifest(seller.manifestUrl, { fetch: seller.fetchImpl });
    expect(result.listed.map((r) => r.name)).toEqual(["quote"]);
    expect(result.skipped).toEqual([
      { endpoint: `${ORIGIN}/weather`, reason: "expected_402_got_200" },
    ]);
  });

  it("skips a service whose live quote disagrees with its manifest entry", async () => {
    const seller = mockSeller({ overrides: { quote: "lie" } });
    const result = await crawlManifest(seller.manifestUrl, { fetch: seller.fetchImpl });
    expect(result.listed.map((r) => r.name)).toEqual(["weather"]);
    expect(result.skipped[0]).toMatchObject({ endpoint: `${ORIGIN}/quote`, reason: "quote_mismatch" });
  });

  it("fails clearly on a manifest that does not validate", async () => {
    const fetchImpl: typeof fetch = async () => Response.json({ x402Version: 1, services: "nope" });
    await expect(crawlManifest("https://bad.example/.well-known/x402", { fetch: fetchImpl })).rejects.toThrow(
      /manifest/i,
    );
  });
});
