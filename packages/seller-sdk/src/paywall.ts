import { createHash, randomUUID } from "node:crypto";
import { InMemoryPendingStore, PendingStoreBusyError, isStoreBusyError, type LeaseHandle, type PendingRecord, type PendingStore } from "./pending-store.js";
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

export interface PaywallConfig {
  /**
   * Base URL of a Stellar x402 facilitator exposing /verify and /settle.
   * Credentials in the URL: `https://TOKEN@host`, `https://:TOKEN@host` or
   * `https://bearer:TOKEN@host` become `Authorization: Bearer TOKEN`; a
   * `user:password` pair (user not "bearer") becomes Basic. Prefer `facilitatorToken`.
   */
  facilitatorUrl: string;
  /** Bearer token for a facilitator running with SELLER_TOKENS. Sent as `Authorization: Bearer`. */
  facilitatorToken?: string;
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
  /** Upper bound for one inclusion check, so a slow Horizon cannot hold a payment's lock. Default 5 s. */
  confirmTimeoutMs?: number;
  /**
   * Upper bound for one facilitator HTTP call (/verify, /settle). A facilitator that accepts and never
   * answers is treated like a lost answer (non-definitive: 409 for /settle). Default 18 s: longer than a
   * slow but honest settle (ledger close plus one retry), shorter than the 20 s most proxies allow a
   * request. Other requests for the same payment stop waiting for the lock after `lockWaitMs` (15 s)
   * with 503, so a hung call costs the holder at most 18 s and nobody else more than 15 s.
   */
  facilitatorTimeoutMs?: number;
  /**
   * Extra seconds a `settlement_pending` record stays retryable after the
   * payment's own validity (`maxTimeoutSeconds` for the envelope time bounds
   * and again for the auth-entry expiry) has run out. Default 30.
   */
  pendingGraceSeconds?: number;
  /**
   * Where in-progress payments are remembered (claim key, hash). Default: in
   * memory, per instance. Pass a `SqlitePendingStore` (or any shared
   * implementation) so a restarted or scaled-out seller can still finish a
   * payment whose facilitator answer was lost.
   */
  pendingStore?: PendingStore;
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
  | { kind: "busy"; status: 503; headers: Record<string, string>; body: { error: "settlement_busy"; retry: string } }
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

type FacilitatorCall<T> =
  | { ok: true; value: T }
  | { ok: false; code: "facilitator_unreachable" | "facilitator_error" | "facilitator_refused"; definitive: boolean };

/**
 * Framework-agnostic x402 paywall for Stellar. Pay-first: a request carrying
 * PAYMENT-SIGNATURE is verified and settled through the facilitator before the
 * resource handler runs; the receipt is returned in PAYMENT-RESPONSE.
 *
 * One payment buys exactly one delivery:
 * - all work on one payment digest is serialized through the pending store's
 *   lock (across every instance sharing the store);
 * - a payment is bound to method + origin + path of the resource it quoted;
 * - before `/settle` the seller writes a record {digest -> claim key}; a lost
 *   answer leaves that record, and the buyer's retry re-asks `/settle` **with
 *   the same claim key**, which only this seller holds; `nonce_reused` is never
 *   turned into a delivery;
 * - after the envelope time bounds and auth expiry have passed, the record
 *   becomes a tombstone: the retry still re-asks with the claim key (a late
 *   landing is served), otherwise it gets a terminal 402 and a fresh quote;
 * - a definitive refusal from the facilitator (4xx) is a 402, never a 409;
 * - every error field is a fixed code; upstream text is never forwarded.
 */
export function createPaywall(cfg: PaywallConfig): Paywall {
  const asset = cfg.asset ?? USDC_SAC[cfg.network];
  if (!asset) throw new Error(`No default asset for ${cfg.network}; pass asset explicitly`);
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const { base: facilitatorUrl, authorization: urlAuth } = splitCredentials(cfg.facilitatorUrl);
  const authorization = cfg.facilitatorToken ? `Bearer ${cfg.facilitatorToken.trim()}` : urlAuth;
  const horizonUrl = (cfg.horizonUrl ?? DEFAULT_HORIZON[cfg.network] ?? "").replace(/\/$/, "");
  const confirmAttempts = cfg.confirmAttempts ?? 3;
  const confirmDelayMs = cfg.confirmDelayMs ?? 1500;
  const confirmTimeoutMs = cfg.confirmTimeoutMs ?? 5000;
  const facilitatorTimeoutMs = cfg.facilitatorTimeoutMs ?? 18_000;
  const confirm = cfg.confirm ?? ((hash: string) => horizonStatus(fetchImpl, horizonUrl, hash));
  const graceMs = (cfg.pendingGraceSeconds ?? 30) * 1000;
  const store: PendingStore = cfg.pendingStore ?? new InMemoryPendingStore();

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

  const pendingAnswer = (resource: ResourceInfo, req: PaymentRequirements, txHash?: string): HandleResult => ({
    kind: "settlement_pending",
    status: 409,
    headers: { "content-type": "application/json", "retry-after": String(Math.ceil(confirmDelayMs / 1000) || 1) },
    body: {
      x402Version: 2,
      error: "settlement_pending",
      resource,
      accepts: [req],
      ...(txHash ? { transaction: txHash } : {}),
      retry: PENDING_RETRY,
    },
  });

  const receipt = (hash: string, req: PaymentRequirements, payer: string | undefined): SettleResponse => ({
    success: true,
    transaction: hash,
    network: req.network,
    ...(payer ? { payer } : {}),
    amount: req.amount,
  });

  /**
   * The only way out as `paid`: the record is consumed atomically under its claim key. If another
   * holder (an instance that took over an expired lease) consumed it first, this caller answers
   * 409 and the buyer re-sends; one payment can never produce two deliveries.
   */
  const deliver = async (
    lease: LeaseHandle,
    rec: PendingRecord,
    resource: ResourceInfo,
    settlement: SettleResponse,
    payer: string | undefined,
  ): Promise<HandleResult> => {
    // A holder whose lease was taken over neither writes nor delivers; the taker owns the outcome now.
    if (!lease.held()) return pendingAnswer(resource, rec.requirements, settlement.transaction || rec.txHash);
    const mine = await store.consume(rec.digest, rec.claimKey);
    if (!mine) return pendingAnswer(resource, rec.requirements, settlement.transaction || rec.txHash);
    return { kind: "paid", headers: { [HEADER_PAYMENT_RESPONSE]: encodeHeader(settlement) }, settlement, payer };
  };

  async function callFacilitator<T>(
    path: "/verify" | "/settle",
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
    parse: (v: unknown) => T,
    claimKey?: string,
  ): Promise<FacilitatorCall<T>> {
    let res: Response | undefined;
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), facilitatorTimeoutMs);
    try {
      // Raced against the clock as well as aborted: a fetch implementation that ignores the signal still ends.
      res = await withTimeout(
        fetchImpl(`${facilitatorUrl}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization ? { authorization } : {}),
            ...(claimKey ? { "idempotency-key": claimKey } : {}),
          },
          body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
          signal: controller.signal,
        }),
        facilitatorTimeoutMs,
        undefined,
      );
    } catch {
      res = undefined;
    } finally {
      clearTimeout(abortTimer);
    }
    if (!res) return { ok: false, code: "facilitator_unreachable", definitive: false };
    if (res.status >= 500) return { ok: false, code: "facilitator_unreachable", definitive: false };
    // 4xx is the facilitator refusing before any claim (auth, budget, malformed): definitive, nothing is pending.
    if (!res.ok) return { ok: false, code: "facilitator_refused", definitive: true };
    try {
      return { ok: true, value: parse(await res.json()) };
    } catch {
      return { ok: false, code: "facilitator_error", definitive: false };
    }
  }

  async function confirmed(hash: string): Promise<ChainStatus> {
    for (let i = 0; i < confirmAttempts; i++) {
      let status: ChainStatus = "UNKNOWN";
      try {
        status = await withTimeout(confirm(hash), confirmTimeoutMs, "UNKNOWN" as ChainStatus);
      } catch {
        status = "UNKNOWN";
      }
      if (status !== "UNKNOWN") return status;
      if (i < confirmAttempts - 1) await new Promise((r) => setTimeout(r, confirmDelayMs));
    }
    return "UNKNOWN";
  }

  /** Decide from a /settle answer made under `rec.claimKey` (ours). */
  async function afterSettle(
    lease: LeaseHandle,
    rec: PendingRecord,
    call: FacilitatorCall<SettleResponse>,
    resource: ResourceInfo,
    price: string,
    method: string,
    payer: string | undefined,
  ): Promise<HandleResult> {
    const req = rec.requirements;
    const expired = rec.state === "expired";
    /**
     * Keep the record for a retry: an owner-checked conditional update, never an insert. If another
     * holder consumed the record meanwhile (this lease lapsed), nothing is written; the buyer's retry finds
     * no record, goes through /verify and is refused as a replay. A holder that cannot prove its lease
     * does not write at all.
     */
    const keep = async (txHash?: string): Promise<HandleResult> => {
      const next: PendingRecord = { ...rec, state: expired ? "expired" : "pending", ...(txHash ? { txHash } : {}) };
      if (lease.held()) await store.update(next);
      return expired ? deny(price, resource, "settlement_expired", method) : pendingAnswer(resource, req, txHash ?? rec.txHash);
    };
    if (!call.ok) {
      if (call.definitive) {
        await store.delete(rec.digest);
        return deny(price, resource, call.code, method);
      }
      return keep();
    }
    const settle = call.value;
    if (settle.success) return deliver(lease, rec, resource, settle, settle.payer ?? payer);
    const reason = settle.errorReason ?? "settlement_failed";
    // Someone else's claim. Never a delivery, whatever the chain says.
    if (reason === "invalid_exact_stellar_payload_nonce_reused") {
      await store.delete(rec.digest);
      return deny(price, resource, reason, method);
    }
    if (reason === "settle_exact_stellar_transaction_failed") {
      await store.delete(rec.digest);
      return deny(price, resource, reason, method);
    }
    const hash = settle.transaction || undefined;
    if (!hash) {
      // Nothing was submitted under our claim: the entry is unspent; quote again.
      await store.delete(rec.digest);
      return deny(price, resource, reason, method);
    }
    const status = await confirmed(hash);
    if (status === "SUCCESS") return deliver(lease, rec, resource, receipt(hash, req, settle.payer ?? payer), settle.payer ?? payer);
    if (status === "FAILED") {
      await store.delete(rec.digest);
      return deny(price, resource, "settle_exact_stellar_transaction_failed", method);
    }
    return keep(hash);
  }

  /** A payment we have a record for: our claim, re-asked with our own claim key. */
  async function resume(lease: LeaseHandle, rec: PendingRecord, payload: PaymentPayload, resource: ResourceInfo, price: string, method: string): Promise<HandleResult> {
    if (rec.state !== "expired" && Date.now() >= rec.expiresAt) {
      rec = { ...rec, state: "expired" };
      if (lease.held()) await store.update(rec); // owner-checked; never re-creates a consumed record
    }
    if (rec.txHash) {
      const status = await confirmed(rec.txHash);
      if (status === "SUCCESS") return deliver(lease, rec, resource, receipt(rec.txHash, rec.requirements, undefined), undefined);
      if (status === "FAILED") {
        await store.delete(rec.digest);
        return deny(price, resource, "settle_exact_stellar_transaction_failed", method);
      }
    }
    const call = await callFacilitator("/settle", payload, rec.requirements, (v) => SettleResponseSchema.parse(v), rec.claimKey);
    return afterSettle(lease, rec, call, resource, price, method, undefined);
  }

  async function handleLocked(lease: LeaseHandle, digest: string, raw: string, { price, resource, method: rawMethod }: HandleInput): Promise<HandleResult> {
    const method = normalizeMethod(rawMethod ?? "GET");
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
    const quotedMethod = normalizeMethod(typeof a.extra?.["method"] === "string" ? (a.extra["method"] as string) : "GET");
    if (quotedMethod !== method) return deny(price, resource, "resource_mismatch", method);

    const rk = resourceKey(resource.url);
    const existing = await store.get(digest);
    if (existing) {
      if (existing.resourceKey !== rk || existing.method !== method) return deny(price, resource, "resource_mismatch", method);
      return resume(lease, existing, payload, resource, price, method);
    }

    const verify = await callFacilitator("/verify", payload, expected, (v) => VerifyResponseSchema.parse(v));
    if (!verify.ok) return deny(price, resource, verify.code, method);
    if (!verify.value.isValid) return deny(price, resource, verify.value.invalidReason ?? "payment_invalid", method);

    // Bind the payment to this resource: a header signed for /a is not money for /b.
    if (!payload.resource || resourceKey(payload.resource.url) !== rk) {
      return deny(price, resource, "resource_mismatch", method);
    }

    // Write-ahead: the claim key is on disk (or in the shared store) before the facilitator can act on it.
    const now = Date.now();
    const rec: PendingRecord = {
      digest,
      resourceKey: rk,
      method,
      requirements: expected,
      claimKey: randomUUID(),
      state: "inflight",
      createdAt: now,
      expiresAt: now + expected.maxTimeoutSeconds * 2 * 1000 + graceMs,
    };
    if (!(await store.put(rec))) return pendingAnswer(resource, expected); // another holder is mid-flight on this payment
    const call = await callFacilitator("/settle", payload, expected, (v) => SettleResponseSchema.parse(v), rec.claimKey);
    return afterSettle(lease, rec, call, resource, price, method, verify.value.payer);
  }

  return {
    config,
    requirements,
    paymentRequired,
    async handle(input) {
      const method = normalizeMethod(input.method ?? "GET");
      const raw = input.headers.get(HEADER_PAYMENT_SIGNATURE) ?? input.headers.get(HEADER_PAYMENT_LEGACY);
      if (!raw) return deny(input.price, input.resource, "payment_required", method);
      const digest = createHash("sha256").update(raw).digest("hex");
      try {
        return await store.withLock(digest, (lease) => handleLocked(lease, digest, raw, input));
      } catch (err) {
        if (err instanceof PendingStoreBusyError || isStoreBusyError(err)) {
          return {
            kind: "busy",
            status: 503,
            headers: { "content-type": "application/json", "retry-after": "5" },
            body: { error: "settlement_busy", retry: "Another request for this payment is in progress. Re-send the same PAYMENT-SIGNATURE shortly." },
          };
        }
        throw err;
      }
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
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

/**
 * Credentials in the facilitator URL. `TOKEN@`, `:TOKEN@` and `bearer:TOKEN@`
 * mean a bearer token (what SELLER_TOKENS expects); only an explicit
 * `user:password` pair becomes Basic.
 */
export function splitCredentials(url: string): { base: string; authorization?: string } {
  const u = new URL(url);
  const base = `${u.origin}${u.pathname}`.replace(/\/$/, "");
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  if (!user && !pass) return { base };
  if (user && pass && user.toLowerCase() !== "bearer") {
    return { base, authorization: `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}` };
  }
  return { base, authorization: `Bearer ${pass || user}` };
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
