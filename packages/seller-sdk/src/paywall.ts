import { createHash, randomUUID } from "node:crypto";
import {
  HEADER_PAYMENT_LEGACY,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  PaymentPayloadSchema,
  SettleResponseSchema,
  USDC_SAC,
  VerifyResponseSchema,
  decodeHeader,
  encodeHeader,
  usdToAtomic,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
  type SettleResponse,
} from "./x402.js";

const DEFAULT_HORIZON: Readonly<Record<string, string>> = {
  "stellar:testnet": "https://horizon-testnet.stellar.org",
  "stellar:pubnet": "https://horizon.stellar.org",
};

export type ChainStatus = "SUCCESS" | "FAILED" | "UNKNOWN";
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

export interface PaywallConfig {
  /** Base URL of a Stellar x402 facilitator exposing /verify and /settle. Userinfo becomes an Authorization header. */
  facilitatorUrl: string;
  /** Seller's Stellar address (G... or C...). */
  payTo: string;
  /** CAIP-2 network, e.g. stellar:testnet. */
  network: string;
  /** Token contract; defaults to USDC on the network. */
  asset?: string;
  /** Seconds the buyer's signature may stay valid. Default 60. */
  maxTimeoutSeconds?: number;
  /** Injectable fetch (tests, custom agents). */
  fetch?: typeof fetch;
  /** Horizon used to confirm an ambiguous settlement by hash. Default per network. */
  horizonUrl?: string;
  /** Injectable inclusion check; default polls Horizon GET /transactions/{hash}. */
  confirm?: (hash: string) => Promise<ChainStatus>;
  confirmAttempts?: number;
  confirmDelayMs?: number;
  /**
   * Extra seconds a `settlement_pending` record stays alive after the
   * payment's own validity (`maxTimeoutSeconds` for the envelope time bounds
   * and again for the auth-entry expiry) has run out. Default 30.
   */
  pendingGraceSeconds?: number;
}

export interface HandleInput {
  /** USD price as a decimal string, e.g. "0.01". */
  price: string;
  resource: ResourceInfo;
  headers: Headers;
  /** HTTP method of the request being paid for. Default GET. */
  method?: string;
}

export interface SettlementPendingBody {
  x402Version: 2;
  error: "settlement_pending";
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  transaction?: string;
  retry: string;
}

export type HandleResult =
  | { kind: "payment_required"; status: 402; headers: Record<string, string>; body: PaymentRequired }
  | { kind: "settlement_pending"; status: 409; headers: Record<string, string>; body: SettlementPendingBody }
  | { kind: "paid"; headers: Record<string, string>; settlement: SettleResponse; payer: string | undefined };

export interface Paywall {
  readonly config: Required<Pick<PaywallConfig, "facilitatorUrl" | "payTo" | "network" | "asset" | "maxTimeoutSeconds">>;
  /** Terms for a price; `method` other than GET is written into `extra.method` so the payment is bound to it. */
  requirements(price: string, method?: string): PaymentRequirements;
  paymentRequired(price: string, resource: ResourceInfo, error?: string, method?: string): PaymentRequired;
  handle(input: HandleInput): Promise<HandleResult>;
}

/** Fixed, client-safe reason codes. Anything else from upstream is collapsed to one of these. */
const CODE = /^[a-z0-9_]{1,80}$/;
const PENDING_RETRY = "Re-send the same PAYMENT-SIGNATURE to this resource. Do not sign a new payment.";
const MAX_PENDING = 1000;

interface Pending {
  resourceKey: string;
  requirements: PaymentRequirements;
  /** The claim identity this seller used on /settle; a retry re-uses it, so only this seller's claim can be read back. */
  claimKey: string;
  txHash?: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Framework-agnostic x402 paywall for Stellar. Pay-first: a request carrying
 * PAYMENT-SIGNATURE is verified and settled through the facilitator before the
 * resource handler runs; the receipt is returned in PAYMENT-RESPONSE.
 *
 * One payment buys exactly one delivery:
 * - requests carrying the same header are processed one at a time; after the
 *   first delivery every later one is refused by the facilitator (`nonce_reused`)
 *   and the seller never delivers on that answer;
 * - a payment is bound to method + origin + path of the resource it quoted;
 * - when settlement is ambiguous (facilitator 5xx, confirmation lost) the buyer
 *   gets HTTP 409 `settlement_pending` with the same terms; the seller keeps a
 *   pending record (payment digest -> claim key, hash) and the buyer re-sends
 *   the same header. The retry re-asks the facilitator **with the same claim
 *   key**, so only this seller's own claim can turn into a delivery; two
 *   concurrent retries yield one delivery;
 * - a pending record expires once the envelope time bounds and the auth-entry
 *   expiry have both passed with no inclusion; the next retry gets a terminal
 *   402 with a fresh quote and the record is dropped;
 * - every error field is a fixed code; upstream text is never forwarded.
 */
export function createPaywall(cfg: PaywallConfig): Paywall {
  const asset = cfg.asset ?? USDC_SAC[cfg.network];
  if (!asset) throw new Error(`No default asset for ${cfg.network}; pass asset explicitly`);
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const { base: facilitatorUrl, authorization } = splitCredentials(cfg.facilitatorUrl);
  const horizonUrl = (cfg.horizonUrl ?? DEFAULT_HORIZON[cfg.network] ?? "").replace(/\/$/, "");
  const confirmAttempts = cfg.confirmAttempts ?? 3;
  const confirmDelayMs = cfg.confirmDelayMs ?? 1500;
  const confirm = cfg.confirm ?? ((hash: string) => horizonStatus(fetchImpl, horizonUrl, hash));
  const graceMs = (cfg.pendingGraceSeconds ?? 30) * 1000;
  const pending = new Map<string, Pending>();
  const inFlight = new Map<string, Promise<unknown>>();

  const config = {
    facilitatorUrl,
    payTo: cfg.payTo,
    network: cfg.network,
    asset,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds ?? 60,
  };

  const requirements = (price: string, method = "GET"): PaymentRequirements => {
    const m = normalizeMethod(method);
    return {
      scheme: "exact",
      network: config.network,
      asset: config.asset,
      amount: usdToAtomic(price),
      payTo: config.payTo,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
      extra: { areFeesSponsored: true, ...(m === "GET" ? {} : { method: m }) },
    };
  };

  const paymentRequired = (price: string, resource: ResourceInfo, error?: string, method = "GET"): PaymentRequired => ({
    x402Version: 2,
    ...(error ? { error } : {}),
    resource,
    accepts: [requirements(price, method)],
  });

  const deny = (price: string, resource: ResourceInfo, error: string, method: string): HandleResult => {
    const body = paymentRequired(price, resource, CODE.test(error) ? error : "payment_invalid", method);
    return {
      kind: "payment_required",
      status: 402,
      headers: { [HEADER_PAYMENT_REQUIRED]: encodeHeader(body), "content-type": "application/json" },
      body,
    };
  };

  const pend = (digest: string, resource: ResourceInfo, req: PaymentRequirements, claimKey: string, txHash?: string): HandleResult => {
    const existing = pending.get(digest);
    if (!existing && pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (oldest) pending.delete(oldest);
    }
    const now = Date.now();
    const ttlMs = req.maxTimeoutSeconds * 2 * 1000 + graceMs;
    pending.set(digest, {
      resourceKey: resourceKey(resource.url),
      requirements: req,
      claimKey,
      createdAt: existing?.createdAt ?? now,
      expiresAt: existing?.expiresAt ?? now + ttlMs,
      ...(txHash ? { txHash } : existing?.txHash ? { txHash: existing.txHash } : {}),
    });
    const body: SettlementPendingBody = {
      x402Version: 2,
      error: "settlement_pending",
      resource,
      accepts: [req],
      ...(txHash ? { transaction: txHash } : {}),
      retry: PENDING_RETRY,
    };
    return {
      kind: "settlement_pending",
      status: 409,
      headers: { "content-type": "application/json", "retry-after": String(Math.ceil(confirmDelayMs / 1000) || 1) },
      body,
    };
  };

  const paid = (digest: string, settlement: SettleResponse, payer: string | undefined): HandleResult => {
    pending.delete(digest);
    return { kind: "paid", headers: { [HEADER_PAYMENT_RESPONSE]: encodeHeader(settlement) }, settlement, payer };
  };

  async function callFacilitator<T>(
    path: "/verify" | "/settle",
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
    parse: (v: unknown) => T,
    claimKey?: string,
  ): Promise<{ ok: true; value: T } | { ok: false; code: "facilitator_unreachable" | "facilitator_error" }> {
    let res: Response;
    try {
      res = await fetchImpl(`${facilitatorUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
          ...(claimKey ? { "idempotency-key": claimKey } : {}),
        },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
      });
    } catch {
      return { ok: false, code: "facilitator_unreachable" };
    }
    if (!res.ok) return { ok: false, code: res.status >= 500 ? "facilitator_unreachable" : "facilitator_error" };
    try {
      return { ok: true, value: parse(await res.json()) };
    } catch {
      return { ok: false, code: "facilitator_error" };
    }
  }

  async function confirmed(hash: string): Promise<ChainStatus> {
    for (let i = 0; i < confirmAttempts; i++) {
      let status: ChainStatus = "UNKNOWN";
      try {
        status = await confirm(hash);
      } catch {
        status = "UNKNOWN";
      }
      if (status !== "UNKNOWN") return status;
      if (i < confirmAttempts - 1) await new Promise((r) => setTimeout(r, confirmDelayMs));
    }
    return "UNKNOWN";
  }

  const receipt = (hash: string, req: PaymentRequirements, payer: string | undefined): SettleResponse => ({
    success: true,
    transaction: hash,
    network: req.network,
    ...(payer ? { payer } : {}),
    amount: req.amount,
  });

  /** Outcome of a /settle answer that is not a clean success; `hash` is whatever we know. */
  async function afterSettle(
    digest: string,
    settle: SettleResponse,
    resource: ResourceInfo,
    req: PaymentRequirements,
    claimKey: string,
    price: string,
    method: string,
    payer: string | undefined,
  ): Promise<HandleResult> {
    if (settle.success) return paid(digest, settle, settle.payer ?? payer);
    const reason = settle.errorReason ?? "settlement_failed";
    // Someone else's claim. Never a delivery, whatever the chain says.
    if (reason === "invalid_exact_stellar_payload_nonce_reused") {
      pending.delete(digest);
      return deny(price, resource, reason, method);
    }
    // The facilitator read the ledger and saw the envelope fail: definitive.
    if (reason === "settle_exact_stellar_transaction_failed") {
      pending.delete(digest);
      return deny(price, resource, reason, method);
    }
    const hash = settle.transaction || undefined;
    if (!hash) {
      // Nothing was submitted under our claim (e.g. submission refused): the entry is unspent; quote again.
      if (reason === "settle_exact_stellar_transaction_submission_failed" || reason === "nonce_store_unavailable") {
        pending.delete(digest);
        return deny(price, resource, reason, method);
      }
      return pend(digest, resource, req, claimKey);
    }
    const status = await confirmed(hash);
    if (status === "SUCCESS") return paid(digest, receipt(hash, req, settle.payer ?? payer), settle.payer ?? payer);
    if (status === "FAILED") {
      pending.delete(digest);
      return deny(price, resource, "settle_exact_stellar_transaction_failed", method);
    }
    return pend(digest, resource, req, claimKey, hash);
  }

  /** A pending settlement retried with the same header: our own claim, re-asked with our own claim key. */
  async function resumePending(
    digest: string,
    entry: Pending,
    payload: PaymentPayload,
    resource: ResourceInfo,
    price: string,
    method: string,
  ): Promise<HandleResult> {
    const req = entry.requirements;
    if (Date.now() >= entry.expiresAt) {
      // Envelope time bounds and auth expiry have passed. One last look at the chain, then terminal.
      if (entry.txHash) {
        const status = await confirmed(entry.txHash);
        if (status === "SUCCESS") return paid(digest, receipt(entry.txHash, req, undefined), undefined);
      }
      pending.delete(digest);
      return deny(price, resource, "settlement_expired", method);
    }
    if (entry.txHash) {
      const status = await confirmed(entry.txHash);
      if (status === "SUCCESS") return paid(digest, receipt(entry.txHash, req, undefined), undefined);
      if (status === "FAILED") {
        pending.delete(digest);
        return deny(price, resource, "settle_exact_stellar_transaction_failed", method);
      }
    }
    const settle = await callFacilitator("/settle", payload, req, (v) => SettleResponseSchema.parse(v), entry.claimKey);
    if (!settle.ok) return pend(digest, resource, req, entry.claimKey, entry.txHash);
    return afterSettle(digest, settle.value, resource, req, entry.claimKey, price, method, undefined);
  }

  async function handleSerialized({ price, resource, headers, method: rawMethod }: HandleInput): Promise<HandleResult> {
    const method = normalizeMethod(rawMethod ?? "GET");
    const raw = headers.get(HEADER_PAYMENT_SIGNATURE) ?? headers.get(HEADER_PAYMENT_LEGACY);
    if (!raw) return deny(price, resource, "payment_required", method);

    let payload: PaymentPayload;
    try {
      payload = PaymentPayloadSchema.parse(decodeHeader(raw));
    } catch {
      return deny(price, resource, "payment_signature_malformed", method);
    }

    const expected = requirements(price, method);
    const a = payload.accepted;
    if (
      a.scheme !== expected.scheme ||
      a.network !== expected.network ||
      a.asset !== expected.asset ||
      a.amount !== expected.amount ||
      a.payTo !== expected.payTo
    ) {
      return deny(price, resource, "accepted_terms_mismatch", method);
    }
    // Method binding: a quote for GET carries no method; any other method is written into extra.method.
    const quotedMethod = normalizeMethod(typeof a.extra?.["method"] === "string" ? (a.extra["method"] as string) : "GET");
    if (quotedMethod !== method) return deny(price, resource, "resource_mismatch", method);

    const digest = createHash("sha256").update(raw).digest("hex");
    const entry = pending.get(digest);
    if (entry) {
      if (entry.resourceKey !== resourceKey(resource.url)) return deny(price, resource, "resource_mismatch", method);
      return resumePending(digest, entry, payload, resource, price, method);
    }

    const verify = await callFacilitator("/verify", payload, expected, (v) => VerifyResponseSchema.parse(v));
    if (!verify.ok) return deny(price, resource, verify.code, method);
    if (!verify.value.isValid) return deny(price, resource, verify.value.invalidReason ?? "payment_invalid", method);

    // Bind the payment to this resource: a header signed for /a is not money for /b.
    if (!payload.resource || resourceKey(payload.resource.url) !== resourceKey(resource.url)) {
      return deny(price, resource, "resource_mismatch", method);
    }

    const claimKey = randomUUID();
    const settle = await callFacilitator("/settle", payload, expected, (v) => SettleResponseSchema.parse(v), claimKey);
    if (!settle.ok) {
      // The facilitator may have submitted before failing to answer: never re-quote as if unpaid.
      return pend(digest, resource, expected, claimKey);
    }
    return afterSettle(digest, settle.value, resource, expected, claimKey, price, method, verify.value.payer);
  }

  return {
    config,
    requirements,
    paymentRequired,
    /** Requests carrying the same payment are handled one at a time, so one payment can only ever deliver once. */
    async handle(input) {
      const raw = input.headers.get(HEADER_PAYMENT_SIGNATURE) ?? input.headers.get(HEADER_PAYMENT_LEGACY);
      if (!raw) return handleSerialized(input);
      const digest = createHash("sha256").update(raw).digest("hex");
      const previous = inFlight.get(digest) ?? Promise.resolve();
      const run = previous.then(() => handleSerialized(input), () => handleSerialized(input));
      const tracked = run.then(() => undefined, () => undefined);
      inFlight.set(digest, tracked);
      try {
        return await run;
      } finally {
        if (inFlight.get(digest) === tracked) inFlight.delete(digest);
      }
    },
  };
}

/** `origin + pathname` of a URL; query strings and fragments do not identify a resource. */
export function resourceKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

function normalizeMethod(m: string): string {
  const u = m.trim().toUpperCase();
  return u || "GET";
}

function splitCredentials(url: string): { base: string; authorization?: string } {
  const u = new URL(url);
  const base = `${u.origin}${u.pathname}`.replace(/\/$/, "");
  if (!u.username && !u.password) return { base };
  const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
  return { base, authorization: `Basic ${Buffer.from(creds, "utf8").toString("base64")}` };
}

/** Horizon inclusion check: 200 with `successful` decides; 404 or anything else is unknown. */
export async function horizonStatus(fetchImpl: typeof fetch, horizonUrl: string, hash: string): Promise<ChainStatus> {
  if (!horizonUrl || !/^[0-9a-f]{64}$/.test(hash)) return "UNKNOWN";
  try {
    const res = await fetchImpl(`${horizonUrl}/transactions/${hash}`, { headers: { accept: "application/json" } });
    if (res.status !== 200) return "UNKNOWN";
    const body = (await res.json()) as { successful?: unknown };
    if (body.successful === true) return "SUCCESS";
    if (body.successful === false) return "FAILED";
    return "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}
