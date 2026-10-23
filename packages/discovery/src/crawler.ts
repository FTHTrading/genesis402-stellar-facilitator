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
import type { ResourceRecord } from "./schema.js";

export interface CrawlOptions {
  fetch?: typeof fetch;
  /** Only list resources payable on this CAIP-2 namespace prefix; default "stellar:". */
  networkPrefix?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  now?: () => Date;
}

export interface Skipped {
  endpoint: string;
  reason: string;
  detail?: string;
}

export interface CrawlResult {
  manifest_url: string;
  seller_origin: string;
  listed: ResourceRecord[];
  skipped: Skipped[];
}

/**
 * Fetches a seller's `/.well-known/x402`, then requests every advertised
 * service without payment. A service is listed only when the live answer is
 * an HTTP 402 whose PaymentRequired quote agrees with the manifest entry
 * (same network, asset, payTo and amount). Anything else is reported in
 * `skipped` with a reason and never enters the index.
 */
export async function crawlManifest(manifestUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const prefix = opts.networkPrefix ?? "stellar:";
  const now = opts.now ?? (() => new Date());

  const manifestRes = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  if (!manifestRes.ok) throw new Error(`manifest fetch failed: HTTP ${manifestRes.status} from ${manifestUrl}`);
  const parsed = ManifestSchema.safeParse(await manifestRes.json().catch(() => null));
  if (!parsed.success) {
    throw new Error(`manifest at ${manifestUrl} does not validate: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  const manifest: Manifest = parsed.data;
  const sellerOrigin = manifest.provider.origin.replace(/\/$/, "");

  const listed: ResourceRecord[] = [];
  const skipped: Skipped[] = [];
  for (const service of manifest.services) {
    const expected = service.accepts.find((a) => a.network.startsWith(prefix));
    if (!expected) {
      skipped.push({ endpoint: service.endpoint, reason: "no_matching_network" });
      continue;
    }
    let quote: PaymentRequired;
    try {
      quote = await fetchQuote(fetchImpl, service, opts.timeoutMs ?? 15_000);
    } catch (err) {
      const message = (err as Error).message;
      skipped.push(
        message.startsWith("expected_402")
          ? { endpoint: service.endpoint, reason: message }
          : { endpoint: service.endpoint, reason: "quote_unavailable", detail: message },
      );
      continue;
    }
    const live = quote.accepts.find((a) => sameLane(a, expected));
    if (!live) {
      skipped.push({ endpoint: service.endpoint, reason: "quote_mismatch", detail: "live 402 does not offer the manifest lane" });
      continue;
    }
    const ts = now().toISOString();
    listed.push({
      id: `${live.network}|${service.method}|${service.endpoint}`,
      seller_origin: sellerOrigin,
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
    });
  }
  return { manifest_url: manifestUrl, seller_origin: sellerOrigin, listed, skipped };
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

async function fetchQuote(fetchImpl: typeof fetch, service: ManifestService, timeoutMs: number): Promise<PaymentRequired> {
  const init: RequestInit = {
    method: service.method,
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (service.method !== "GET") {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = "{}";
  }
  const res = await fetchImpl(service.endpoint, init);
  if (res.status !== 402) throw new Error(`expected_402_got_${res.status}`);
  const header = res.headers.get(HEADER_PAYMENT_REQUIRED);
  const candidates: unknown[] = [];
  if (header) {
    try {
      candidates.push(decodeHeader(header));
    } catch {
      /* fall through to body */
    }
  }
  candidates.push(await res.json().catch(() => null));
  for (const c of candidates) {
    const p = PaymentRequiredSchema.safeParse(c);
    if (p.success) return p.data;
  }
  throw new Error("402 without a valid PaymentRequired document");
}
