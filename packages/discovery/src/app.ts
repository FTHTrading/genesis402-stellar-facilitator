import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { CrawlError, crawlManifest, type CrawlErrorCode, type CrawlOptions } from "./crawler.js";
import type { ResourceIndex } from "./index-store.js";
import { RegisterSellerSchema, resourceRecordJsonSchema, type ResourceQuery } from "./schema.js";
import type { Resolver } from "./url-guard.js";

export interface DiscoveryAppOptions {
  index: ResourceIndex;
  fetch?: typeof fetch;
  resolve?: Resolver;
  /** Local development only: permit http:// and private/loopback crawl targets. */
  allowLocalTargets?: boolean;
  /** Registrations accepted per client IP per window (default 5 per 10 minutes). */
  registrationsPerWindow?: number;
  rateWindowMs?: number;
  now?: () => number;
}

export interface CrawlJob {
  id: string;
  manifest_url: string;
  status: "queued" | "running" | "done" | "failed";
  created_at: string;
  finished_at?: string;
  listed?: number;
  skipped?: Array<{ endpoint: string; reason: string }>;
  error?: CrawlErrorCode | "crawl_failed";
}

const MAX_JOBS_KEPT = 1000;

/**
 * Bazaar-style discovery API.
 *   GET  /discovery/resources?network=stellar:testnet&max_amount=&category=&seller=&q=&limit=
 *   POST /discovery/sellers { manifest_url }  -> 202 { job_id }, crawl runs in a queue
 *   GET  /discovery/jobs/:id                   -> job status; fixed error codes only
 *   GET  /discovery/sellers
 *   GET  /discovery/schema
 *   GET  /health
 * Reads are CORS-open; registration is same-origin only and rate-limited per IP.
 */
export function createDiscoveryApp(opts: DiscoveryAppOptions): Hono {
  const app = new Hono();
  const now = opts.now ?? (() => Date.now());
  const windowMs = opts.rateWindowMs ?? 10 * 60_000;
  const perWindow = opts.registrationsPerWindow ?? 5;
  const buckets = new Map<string, number[]>();
  const jobs = new Map<string, CrawlJob>();
  const queue: CrawlJob[] = [];
  let running = false;

  const crawlOpts: CrawlOptions = {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.resolve ? { resolve: opts.resolve } : {}),
    ...(opts.allowLocalTargets ? { allowHttp: true, allowPrivate: true } : {}),
  };

  const readCors = cors({ origin: "*", allowMethods: ["GET"] });
  app.use("*", async (c, next) => {
    if (c.req.method === "GET") return readCors(c, next);
    if (c.req.method === "OPTIONS" && c.req.header("access-control-request-method") === "GET") {
      return readCors(c, next);
    }
    await next();
  });

  app.get("/", (c) =>
    c.json({
      name: "genesis402-stellar-discovery",
      endpoints: ["/discovery/resources", "/discovery/sellers", "/discovery/jobs/:id", "/discovery/schema", "/health"],
    }),
  );
  app.get("/health", (c) => c.json({ status: "ok", resources: opts.index.count(), queued: queue.length }));

  app.get("/discovery/resources", (c) => {
    const u = c.req.query();
    const q: ResourceQuery = {
      ...(u["network"] ? { network: u["network"] } : {}),
      ...(u["max_amount"] ? { maxAmount: u["max_amount"] } : {}),
      ...(u["category"] ? { category: u["category"] } : {}),
      ...(u["seller"] ? { seller: u["seller"] } : {}),
      ...(u["q"] ? { q: u["q"].slice(0, 100) } : {}),
      ...(u["limit"] ? { limit: Number(u["limit"]) } : {}),
    };
    if (q.maxAmount !== undefined && !/^\d{1,24}$/.test(q.maxAmount)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const resources = opts.index.query(q);
    return c.json({ x402Version: 2, count: resources.length, resources, generated_at: new Date().toISOString() });
  });

  app.get("/discovery/sellers", (c) => c.json({ sellers: opts.index.sellers() }));

  // Public job view: status and outcome only. The submitted URL is not echoed, so the
  // job endpoint cannot be used to confirm which internal hosts someone probed.
  app.get("/discovery/jobs/:id", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "not_found" }, 404);
    const { manifest_url: _omit, ...view } = job;
    return c.json(view);
  });

  app.post("/discovery/sellers", async (c) => {
    const ip = clientIp(c.req.raw.headers);
    const t = now();
    const hits = (buckets.get(ip) ?? []).filter((x) => t - x < windowMs);
    if (hits.length >= perWindow) {
      buckets.set(ip, hits);
      return c.json({ error: "rate_limited" }, 429, { "retry-after": String(Math.ceil(windowMs / 1000)) });
    }
    const parsed = RegisterSellerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    hits.push(t);
    buckets.set(ip, hits);

    const job: CrawlJob = {
      id: randomUUID(),
      manifest_url: parsed.data.manifest_url,
      status: "queued",
      created_at: new Date().toISOString(),
    };
    remember(job);
    queue.push(job);
    void pump();
    return c.json({ job_id: job.id, status: job.status, poll: `/discovery/jobs/${job.id}` }, 202);
  });

  app.get("/discovery/schema", (c) => c.json(resourceRecordJsonSchema()));

  function remember(job: CrawlJob): void {
    jobs.set(job.id, job);
    if (jobs.size > MAX_JOBS_KEPT) {
      const oldest = jobs.keys().next().value;
      if (oldest) jobs.delete(oldest);
    }
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        job.status = "running";
        try {
          const result = await crawlManifest(job.manifest_url, crawlOpts);
          for (const r of result.listed) opts.index.upsert(r);
          opts.index.recordCrawl({
            manifest_url: result.manifest_url,
            seller_origin: result.seller_origin,
            last_crawled_at: new Date().toISOString(),
            listed: result.listed.length,
            skipped: result.skipped.length,
          });
          job.status = "done";
          job.listed = result.listed.length;
          job.skipped = result.skipped.map((s) => ({ endpoint: s.endpoint, reason: s.reason }));
        } catch (err) {
          job.status = "failed";
          job.error = err instanceof CrawlError ? err.code : "crawl_failed";
        }
        job.finished_at = new Date().toISOString();
      }
    } finally {
      running = false;
    }
  }

  return app;
}

function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return headers.get("x-real-ip") ?? "direct";
}
