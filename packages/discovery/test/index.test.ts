import { describe, expect, it } from "vitest";
import { SqliteResourceIndex } from "../src/index-store.js";
import type { ResourceRecord } from "../src/schema.js";

function rec(overrides: Partial<ResourceRecord>): ResourceRecord {
  const now = new Date().toISOString();
  return {
    id: `${overrides.network ?? "stellar:testnet"}|GET|https://s.example/${overrides.name ?? "a"}`,
    seller_origin: "https://s.example",
    manifest_url: "https://s.example/.well-known/x402",
    name: "a",
    endpoint: `https://s.example/${overrides.name ?? "a"}`,
    method: "GET",
    title: "t",
    what_you_get: "w",
    price_usd: "0.01",
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    amount: "100000",
    payTo: "GSELLER",
    accepts: [],
    quote_verified_at: now,
    first_seen: now,
    last_seen: now,
    ...overrides,
  };
}

describe("SqliteResourceIndex", () => {
  it("upserts by id and filters by network, max amount and category", () => {
    const idx = new SqliteResourceIndex(":memory:");
    idx.upsert(rec({ name: "cheap", amount: "100000", category: "data" }));
    idx.upsert(rec({ name: "dear", amount: "2500000", category: "finance" }));
    idx.upsert(rec({ name: "pub", network: "stellar:pubnet", amount: "100000" }));
    idx.upsert(rec({ name: "cheap", amount: "100000", category: "data", title: "updated" }));

    expect(idx.query({ network: "stellar:testnet" }).map((r) => r.name).sort()).toEqual(["cheap", "dear"]);
    expect(idx.query({ network: "stellar:testnet", maxAmount: "1000000" }).map((r) => r.name)).toEqual(["cheap"]);
    expect(idx.query({ category: "finance" }).map((r) => r.name)).toEqual(["dear"]);
    expect(idx.query({ network: "stellar:pubnet" })).toHaveLength(1);
    expect(idx.query({ network: "eip155:8453" })).toEqual([]);
    expect(idx.query({ network: "stellar:testnet" }).find((r) => r.name === "cheap")?.title).toBe("updated");
    expect(idx.count()).toBe(3);
  });
});
