import {
  HEADER_PAYMENT_REQUIRED,
  ManifestSchema,
  PaymentRequiredSchema,
  decodeHeader,
  type Manifest,
  type ManifestService,
  type PaymentRequired,
  type PaymentRequirements,
} from "@genesis402/stellar-seller-sdk";
import { pinnedInit } from "./pinned-fetch.js";
import type { ResourceRecord } from "./schema.js";
import { TargetNotAllowedError, resolveSafeTarget, type GuardOptions, type Resolver } from "./url-guard.js";

/** Hard limits on what one crawl may pull in. */
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_SERVICES_PER_MANIFEST = 50;
export const CRAWL_CONCURRENCY = 4;

/** Fixed, client-safe failure codes. Nothing else is ever surfaced to API callers. */
export type CrawlErrorCode =
  | "target_not_allowed"
  | "manifest_unreachable"
  | "manifest_invalid"
  | "origin_mismatch"
  | "body_too_large";

export class CrawlError extends Error {
  constructor(
    readonly code: CrawlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CrawlError";
  }
}

export interface CrawlOptions extends GuardOptions {
  /** Injectable fetch. When omitted the global fetch is used with DNS pinned to the guard's answer. */
  fetch?: typeof fetch;
  /** Only list resources payable on this CAIP-2 namespace prefix; default "stellar:". */
  networkPrefix?: string;
  timeoutMs?: number;
  now?: () => Date;
  resolve?: Resolver;
}

export interface Skipped {
  endpoint: string;
  reason: string;
  detail?: string;
}

export interface CrawlResult {
  manifest_url: string;
  /** Always the origin of `manifest_url`, never anything the manifest body claims. */
  seller_origin: string;
  listed: ResourceRecord[];
  skipped: Skipped[];
}

/**
 * Fetches a seller's `/.well-known/x402`, then requests every advertised
 * service without payment. A service is listed only when the live answer is
 * an HTTP 402 whose PaymentRequired quote agrees with the manifest entry
 * (same network, asset, payTo and amount). Anything else lands in `skipped`.
 *
 * Trust boundary: the manifest is attacker-controlled input. The seller's
 * identity is the manifest URL's origin; endpoints on any other origin are
 * never fetched; every URL passes the SSRF guard and the connection is pinned
 * to the vetted addresses; redirects are not followed; bodies are capped at
 * 256 KiB; at most 50 services are examined, 4 at a time.
 */
export async function crawlManifest(manifestUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const injected = opts.fetch;
  const fetchImpl = injected ?? globalThis.fetch;
  const prefix = opts.networkPrefix ?? "stellar:";
  const now = opts.now ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const guard: GuardOptions = {
    ...(opts.resolve ? { resolve: opts.resolve } : {}),
    ...(opts.allowHttp ? { allowHttp: true } : {}),
    ...(opts.allowPrivate ? { allowPrivate: true } : {}),
  };
  /** With the global fetch, pin DNS to what the guard saw; an injected fetch (tests) is used as-is. */
  const withPin = (init: RequestInit, addresses: string[]): RequestInit =>
    injected ? init : pinnedInit(init, addresses);

  const manifestAddresses = await guardOrThrow(manifestUrl, guard);
  const manifestOrigin = new URL(manifestUrl).origin;

  let manifestRes: Response;
  try {
    manifestRes = await fetchImpl(
      manifestUrl,
      withPin(
        { redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) },
        manifestAddresses,
      ),
    );
  } catch (err) {
    throw new CrawlError("manifest_unreachable", (err as Error).message);
  }
  if (manifestRes.status !== 200) {
    throw new CrawlError("manifest_unreachable", `HTTP ${manifestRes.status}`);
  }
  const manifestJson = await readJsonCapped(manifestRes);
  const parsed = ManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    throw new CrawlError("manifest_invalid", parsed.error.issues[0]?.message ?? "schema");
  }
  const manifest: Manifest = parsed.data;
  if (new URL(manifest.provider.origin).host !== new URL(manifestUrl).host) {
    throw new CrawlError("origin_mismatch", "provider.origin host differs from manifest host");
  }

  const listed: ResourceRecord[] = [];
  const skipped: Skipped[] = [];
  const services = manifest.services.slice(0, MAX_SERVICES_PER_MANIFEST);
  for (const extra of manifest.services.slice(MAX_SERVICES_PER_MANIFEST)) {
    skipped.push({ endpoint: extra.endpoint, reason: "services_cap_exceeded" });
  }

  const results = await mapWithConcurrency(services, CRAWL_CONCURRENCY, async (service) => {
    const expected = service.accepts.find((a) => a.network.startsWith(prefix));
    if (!expected) return { skip: { endpoint: service.endpoint, reason: "no_matching_network" } };
    let endpointOrigin: string;
    try {
      endpointOrigin = new URL(service.endpoint).origin;
    } catch {
      return { skip: { endpoint: service.endpoint, reason: "invalid_endpoint" } };
    }
    if (endpointOrigin !== manifestOrigin) {
      return { skip: { endpoint: service.endpoint, reason: "cross_origin_endpoint" } };
    }
    // Same origin as the manifest, so the vetted addresses apply; re-run the guard anyway (cheap, literal check).
    let addresses: string[];
    try {
      addresses = await resolveSafeTarget(service.endpoint, { ...guard, resolve: async () => manifestAddresses });
    } catch {
      return { skip: { endpoint: service.endpoint, reason: "target_not_allowed" } };
    }
    let quote: PaymentRequired;
    try {
      quote = await fetchQuote(fetchImpl, service, timeoutMs, (init) => withPin(init, addresses));
    } catch (err) {
      const message = (err as Error).message;
      return {
        skip: message.startsWith("expected_402")
          ? { endpoint: service.endpoint, reason: message }
          : { endpoint: service.endpoint, reason: "quote_unavailable", detail: message },
      };
    }
    const live = quote.accepts.find((a) => sameLane(a, expected));
    if (!live) {
      return {
        skip: { endpoint: service.endpoint, reason: "quote_mismatch", detail: "live 402 does not offer the manifest lane" },
      };
    }
    const ts = now().toISOString();
    const record: ResourceRecord = {
      id: `${live.network}|${service.method}|${service.endpoint}`,
      seller_origin: manifestOrigin,
      manifest_url: manifestUrl,
      name: service.name,
      endpoint: service.endpoint,
      method: service.method,
      title: service.title,
      what_you_get: service.what_you_get,
      price_usd: service.price_usd,
      ...(service.category ? { category: service.category } : {}),
      scheme: live.scheme,
      network: live.network,
      asset: live.asset,
      amount: live.amount,
      payTo: live.payTo,
      accepts: quote.accepts,
      ...(service.input_schema ? { input_schema: service.input_schema } : {}),
      ...(service.output_schema ? { output_schema: service.output_schema } : {}),
      quote_verified_at: ts,
      first_seen: ts,
      last_seen: ts,
    };
    return { record };
  });
  for (const r of results) {
    if ("record" in r) listed.push(r.record);
    else skipped.push(r.skip);
  }
  return { manifest_url: manifestUrl, seller_origin: manifestOrigin, listed, skipped };
}

async function guardOrThrow(url: string, guard: GuardOptions): Promise<string[]> {
  try {
    return await resolveSafeTarget(url, guard);
  } catch (err) {
    if (err instanceof TargetNotAllowedError) throw new CrawlError("target_not_allowed", err.message);
    throw err;
  }
}

/** Streams a JSON body, aborting past MAX_BODY_BYTES; requires an application/json content type. */
export async function readJsonCapped(res: Response, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json\b/i.test(ct)) {
    throw new CrawlError("manifest_invalid", `content-type ${ct || "missing"} is not JSON`);
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new CrawlError("body_too_large", `content-length ${declared}`);
  if (!res.body) throw new CrawlError("manifest_invalid", "empty body");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new CrawlError("body_too_large", `body exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CrawlError("manifest_invalid", "body is not JSON");
  }
}

function sameLane(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.asset === b.asset &&
    a.payTo === b.payTo &&
    a.amount === b.amount
  );
}

async function fetchQuote(
  fetchImpl: typeof fetch,
  service: ManifestService,
  timeoutMs: number,
  pin: (init: RequestInit) => RequestInit,
): Promise<PaymentRequired> {
  const init: RequestInit = {
    method: service.method,
    redirect: "manual",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (service.method !== "GET") {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = "{}";
  }
  const res = await fetchImpl(service.endpoint, pin(init));
  if (res.status !== 402) throw new Error(`expected_402_got_${res.status}`);
  const candidates: unknown[] = [];
  const header = res.headers.get(HEADER_PAYMENT_REQUIRED);
  if (header && header.length <= MAX_BODY_BYTES) {
    try {
      candidates.push(decodeHeader(header));
    } catch {
      /* fall through to body */
    }
  }
  try {
    candidates.push(await readJsonCapped(res));
  } catch {
    /* header may still carry the document */
  }
  for (const c of candidates) {
    const p = PaymentRequiredSchema.safeParse(c);
    if (p.success) return p.data;
  }
  throw new Error("402 without a valid PaymentRequired document");
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
