import { describe, expect, it } from "vitest";
import { createDiscoveryApp } from "../src/app.js";
import { SqliteResourceIndex } from "../src/index-store.js";
import { mockSeller } from "./mock-seller.js";

describe("discovery HTTP API", () => {
  it("registers a seller, crawls it, and serves it under /discovery/resources", async () => {
    const seller = mockSeller();
    const app = createDiscoveryApp({ index: new SqliteResourceIndex(":memory:"), fetch: seller.fetchImpl });

    const reg = await app.request("/discovery/sellers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest_url: seller.manifestUrl }),
    });
    expect(reg.status).toBe(200);
    expect(await reg.json()).toMatchObject({ listed: 2, skipped: [] });

    const list = await app.request("/discovery/resources?network=stellar:testnet");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { count: number; resources: Array<{ name: string }> };
    expect(body.count).toBe(2);
    expect(body.resources.map((r) => r.name).sort()).toEqual(["quote", "weather"]);

    const none = await app.request("/discovery/resources?network=stellar:pubnet");
    expect(((await none.json()) as { count: number }).count).toBe(0);

    const sellers = await app.request("/discovery/sellers");
    expect(((await sellers.json()) as { sellers: unknown[] }).sellers).toHaveLength(1);
  });

  it("rejects a registration without a manifest URL and publishes the record JSON schema", async () => {
    const app = createDiscoveryApp({ index: new SqliteResourceIndex(":memory:") });
    const bad = await app.request("/discovery/sellers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);

    const schema = await app.request("/discovery/schema");
    expect(schema.status).toBe(200);
    const json = (await schema.json()) as { properties?: Record<string, unknown>; $schema?: string };
    expect(json.properties).toHaveProperty("endpoint");
    expect(json.properties).toHaveProperty("network");
  });
});
