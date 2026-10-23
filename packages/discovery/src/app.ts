import { randomUUID } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
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
  /**
   * Trust X-Forwarded-For / X-Real-IP for the client identity. Only set this
   * behind a proxy that overwrites those headers. Default false: the socket
   * address identifies the client and forwarded headers are ignored.
   */
  trustProxy?: boolean;
  /** Registrations accepted per client per window (default 5 per 10 minutes). */
  registrationsPerWindow?: number;
  rateWindowMs?: number;
  /** Jobs that may wait in the crawl queue; further registrations get 503 (default 100). */
  maxQueue?: number;
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
/** Clients that cannot be told apart (no socket, no trusted proxy) share one coarse bucket. */
const UNIDENTIFIED_MULTIPLIER = 4;

/**
 * Bazaar-style discovery API.
 *   GET  /discovery/resources?network=stellar:testnet&max_amount=&category=&seller=&q=&limit=
 *   POST /discovery/sellers { manifest_url }  -> 202 { job_id }, crawl runs in a bounded queue
 *   GET  /discovery/jobs/:id                   -> job status; fixed error codes only
 *   GET  /discovery/sellers
 *   GET  /discovery/schema
 *   GET  /health
 * Reads are CORS-open; registration is same-origin only and rate-limited per client.
 */
export function createDiscoveryApp(opts: DiscoveryAppOptions): Hono {
  const app = new Hono();
  const now = opts.now ?? (() => Date.now());
  const windowMs = opts.rateWindowMs ?? 10 * 60_000;
  const perWindow = opts.registrationsPerWindow ?? 5;
  const maxQueue = opts.maxQueue ?? 100;
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
    const { key, identified } = clientKey(c, opts.trustProxy === true);
    const allowance = identified ? perWindow : perWindow * UNIDENTIFIED_MULTIPLIER;
    const t = now();
    const hits = (buckets.get(key) ?? []).filter((x) => t - x < windowMs);
    if (hits.length >= allowance) {
      buckets.set(key, hits);
      return c.json({ error: "rate_limited" }, 429, { "retry-after": String(Math.ceil(windowMs / 1000)) });
    }
    if (queue.length >= maxQueue) return c.json({ error: "queue_full" }, 503, { "retry-after": "60" });
    const parsed = RegisterSellerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    hits.push(t);
    buckets.set(key, hits);
    if (buckets.size > 10_000) buckets.delete(buckets.keys().next().value!);

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

/**
 * Who is registering. With a trusted proxy, the first X-Forwarded-For hop.
 * Otherwise the socket address; forwarded headers from a direct client are
 * ignored for identity and such clients share one bucket (they are lying about
 * a proxy that is not there). With neither socket nor trusted header (embedded
 * use, tests) the client is unidentified and only the coarse bucket applies.
 */
export function clientKey(c: Context, trustProxy: boolean): { key: string; identified: boolean } {
  const xff = c.req.header("x-forwarded-for");
  const realIp = c.req.header("x-real-ip");
  if (trustProxy) {
    const ip = xff?.split(",")[0]?.trim() || realIp?.trim();
    if (ip) return { key: `proxy:${ip}`, identified: true };
  }
  let socketIp: string | undefined;
  try {
    socketIp = getConnInfo(c).remote.address;
  } catch {
    socketIp = undefined;
  }
  if (socketIp) return { key: `socket:${socketIp}`, identified: true };
  if (xff || realIp) return { key: "untrusted-forwarded", identified: true };
  return { key: "unidentified", identified: false };
}
