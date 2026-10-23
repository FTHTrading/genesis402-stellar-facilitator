import { Hono } from "hono";
import { cors } from "hono/cors";
import { crawlManifest } from "./crawler.js";
import type { ResourceIndex } from "./index-store.js";
import { RegisterSellerSchema, resourceRecordJsonSchema, type ResourceQuery } from "./schema.js";

export interface DiscoveryAppOptions {
  index: ResourceIndex;
  fetch?: typeof fetch;
}

/**
 * Bazaar-style discovery API:
 *   GET  /discovery/resources?network=stellar:testnet&max_amount=&category=&seller=&q=&limit=
 *   POST /discovery/sellers { manifest_url }   -> crawl now, list what answered a real 402
 *   GET  /discovery/sellers
 *   GET  /discovery/schema                      -> JSON Schema of a resource record
 *   GET  /health
 */
export function createDiscoveryApp(opts: DiscoveryAppOptions): Hono {
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

  app.get("/", (c) =>
    c.json({
      name: "genesis402-stellar-discovery",
      endpoints: ["/discovery/resources", "/discovery/sellers", "/discovery/schema", "/health"],
    }),
  );
  app.get("/health", (c) => c.json({ status: "ok", resources: opts.index.count() }));

  app.get("/discovery/resources", (c) => {
    const u = c.req.query();
    const q: ResourceQuery = {
      ...(u["network"] ? { network: u["network"] } : {}),
      ...(u["max_amount"] ? { maxAmount: u["max_amount"] } : {}),
      ...(u["category"] ? { category: u["category"] } : {}),
      ...(u["seller"] ? { seller: u["seller"] } : {}),
      ...(u["q"] ? { q: u["q"] } : {}),
      ...(u["limit"] ? { limit: Number(u["limit"]) } : {}),
    };
    if (q.maxAmount !== undefined && !/^\d+$/.test(q.maxAmount)) {
      return c.json({ error: "invalid_request", message: "max_amount must be an integer" }, 400);
    }
    const resources = opts.index.query(q);
    return c.json({ x402Version: 2, count: resources.length, resources, generated_at: new Date().toISOString() });
  });

  app.get("/discovery/sellers", (c) => c.json({ sellers: opts.index.sellers() }));

  app.post("/discovery/sellers", async (c) => {
    const parsed = RegisterSellerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    try {
      const result = await crawlManifest(parsed.data.manifest_url, {
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      for (const r of result.listed) opts.index.upsert(r);
      opts.index.recordCrawl({
        manifest_url: result.manifest_url,
        seller_origin: result.seller_origin,
        last_crawled_at: new Date().toISOString(),
        listed: result.listed.length,
        skipped: result.skipped.length,
      });
      return c.json({
        manifest_url: result.manifest_url,
        seller_origin: result.seller_origin,
        listed: result.listed.length,
        skipped: result.skipped,
        resources: result.listed.map((r) => r.id),
      });
    } catch (err) {
      return c.json({ error: "crawl_failed", message: (err as Error).message }, 422);
    }
  });

  app.get("/discovery/schema", (c) => c.json(resourceRecordJsonSchema()));

  return app;
}
