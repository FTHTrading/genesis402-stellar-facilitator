import { createHash } from "node:crypto";
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
}

export interface HandleInput {
  /** USD price as a decimal string, e.g. "0.01". */
  price: string;
  resource: ResourceInfo;
  headers: Headers;
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
  requirements(price: string): PaymentRequirements;
  paymentRequired(price: string, resource: ResourceInfo, error?: string): PaymentRequired;
  handle(input: HandleInput): Promise<HandleResult>;
}

/** Fixed, client-safe reason codes. Anything else from upstream is collapsed to one of these. */
const CODE = /^[a-z0-9_]{1,80}$/;
const PENDING_RETRY = "Re-send the same PAYMENT-SIGNATURE to this resource. Do not sign a new payment.";
const MAX_PENDING = 1000;

interface Pending {
  resourceKey: string;
  requirements: PaymentRequirements;
  txHash?: string;
  at: number;
}

/**
 * Framework-agnostic x402 paywall for Stellar. Pay-first: a request carrying
 * PAYMENT-SIGNATURE is verified and settled through the facilitator before the
 * resource handler runs; the receipt is returned in PAYMENT-RESPONSE.
 *
 * Failure handling is designed so a buyer can never be charged twice:
 * - a payment is bound to the resource it quotes (`resource.url`), so a header
 *   signed for one route is refused on another;
 * - when settlement is ambiguous (facilitator 5xx after submit, confirmation
 *   poll failed) the buyer gets HTTP 409 `settlement_pending` with the same
 *   terms and must re-send the same header; the seller then checks the chain
 *   and delivers once the transaction is included;
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
  const pending = new Map<string, Pending>();

  const config = {
    facilitatorUrl,
    payTo: cfg.payTo,
    network: cfg.network,
    asset,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds ?? 60,
  };

  const requirements = (price: string): PaymentRequirements => ({
    scheme: "exact",
    network: config.network,
    asset: config.asset,
    amount: usdToAtomic(price),
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    extra: { areFeesSponsored: true },
  });

  const paymentRequired = (price: string, resource: ResourceInfo, error?: string): PaymentRequired => ({
    x402Version: 2,
    ...(error ? { error } : {}),
    resource,
    accepts: [requirements(price)],
  });

  const deny = (price: string, resource: ResourceInfo, error: string): HandleResult => {
    const body = paymentRequired(price, resource, CODE.test(error) ? error : "payment_invalid");
    return {
      kind: "payment_required",
      status: 402,
      headers: { [HEADER_PAYMENT_REQUIRED]: encodeHeader(body), "content-type": "application/json" },
      body,
    };
  };

  const pend = (digest: string, resource: ResourceInfo, req: PaymentRequirements, txHash?: string): HandleResult => {
    if (!pending.has(digest) && pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (oldest) pending.delete(oldest);
    }
    pending.set(digest, { resourceKey: resourceKey(resource.url), requirements: req, at: Date.now(), ...(txHash ? { txHash } : {}) });
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
  ): Promise<{ ok: true; value: T } | { ok: false; code: "facilitator_unreachable" | "facilitator_error" }> {
    let res: Response;
    try {
      res = await fetchImpl(`${facilitatorUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
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

  /** A pending settlement is re-checked on retry: chain first if we know the hash, else the facilitator. */
  async function resumePending(
    digest: string,
    entry: Pending,
    payload: PaymentPayload,
    resource: ResourceInfo,
  ): Promise<HandleResult> {
    const req = entry.requirements;
    let hash = entry.txHash;
    let payer: string | undefined;
    if (!hash) {
      const settle = await callFacilitator("/settle", payload, req, (v) => SettleResponseSchema.parse(v));
      if (!settle.ok) return pend(digest, resource, req);
      if (settle.value.success) return paid(digest, settle.value, settle.value.payer);
      payer = settle.value.payer;
      hash = settle.value.transaction || undefined;
      if (!hash) {
        pending.delete(digest);
        return deny(usdFromAtomic(req.amount), resource, settle.value.errorReason ?? "settlement_failed");
      }
    }
    const status = await confirmed(hash);
    if (status === "SUCCESS") return paid(digest, receipt(hash, req, payer), payer);
    if (status === "FAILED") {
      pending.delete(digest);
      return deny(usdFromAtomic(req.amount), resource, "settle_exact_stellar_transaction_failed");
    }
    return pend(digest, resource, req, hash);
  }

  return {
    config,
    requirements,
    paymentRequired,
    async handle({ price, resource, headers }) {
      const raw = headers.get(HEADER_PAYMENT_SIGNATURE) ?? headers.get(HEADER_PAYMENT_LEGACY);
      if (!raw) return deny(price, resource, "payment_required");

      let payload: PaymentPayload;
      try {
        payload = PaymentPayloadSchema.parse(decodeHeader(raw));
      } catch {
        return deny(price, resource, "payment_signature_malformed");
      }

      const expected = requirements(price);
      const a = payload.accepted;
      if (
        a.scheme !== expected.scheme ||
        a.network !== expected.network ||
        a.asset !== expected.asset ||
        a.amount !== expected.amount ||
        a.payTo !== expected.payTo
      ) {
        return deny(price, resource, "accepted_terms_mismatch");
      }

      const digest = createHash("sha256").update(raw).digest("hex");
      const entry = pending.get(digest);
      if (entry) {
        if (entry.resourceKey !== resourceKey(resource.url)) return deny(price, resource, "resource_mismatch");
        return resumePending(digest, entry, payload, resource);
      }

      const verify = await callFacilitator("/verify", payload, expected, (v) => VerifyResponseSchema.parse(v));
      if (!verify.ok) return deny(price, resource, verify.code);
      if (!verify.value.isValid) return deny(price, resource, verify.value.invalidReason ?? "payment_invalid");

      // Bind the payment to this resource: a header signed for /a is not money for /b.
      if (!payload.resource || resourceKey(payload.resource.url) !== resourceKey(resource.url)) {
        return deny(price, resource, "resource_mismatch");
      }

      const settle = await callFacilitator("/settle", payload, expected, (v) => SettleResponseSchema.parse(v));
      if (!settle.ok) {
        // The facilitator may have submitted before failing to answer: never re-quote as if unpaid.
        return pend(digest, resource, expected);
      }
      if (settle.value.success) return paid(digest, settle.value, settle.value.payer ?? verify.value.payer);

      // A FAILED verdict from the facilitator is definitive (it read the ledger); anything else with a hash is ambiguous.
      const hash = settle.value.transaction;
      if (hash && settle.value.errorReason !== "settle_exact_stellar_transaction_failed") {
        const status = await confirmed(hash);
        if (status === "SUCCESS") {
          return paid(digest, receipt(hash, expected, settle.value.payer ?? verify.value.payer), settle.value.payer);
        }
        if (status === "UNKNOWN") return pend(digest, resource, expected, hash);
      }
      return deny(price, resource, settle.value.errorReason ?? "settlement_failed");
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

function splitCredentials(url: string): { base: string; authorization?: string } {
  const u = new URL(url);
  const base = `${u.origin}${u.pathname}`.replace(/\/$/, "");
  if (!u.username && !u.password) return { base };
  const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
  return { base, authorization: `Basic ${Buffer.from(creds, "utf8").toString("base64")}` };
}

function usdFromAtomic(amount: string): string {
  const padded = amount.padStart(8, "0");
  return `${padded.slice(0, -7)}.${padded.slice(-7)}`.replace(/\.?0+$/, "") || "0";
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
