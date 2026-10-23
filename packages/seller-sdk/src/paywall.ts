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

export interface PaywallConfig {
  /** Base URL of a Stellar x402 facilitator exposing /verify and /settle. */
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
}

export interface HandleInput {
  /** USD price as a decimal string, e.g. "0.01". */
  price: string;
  resource: ResourceInfo;
  headers: Headers;
}

export type HandleResult =
  | { kind: "payment_required"; status: 402; headers: Record<string, string>; body: PaymentRequired }
  | { kind: "paid"; headers: Record<string, string>; settlement: SettleResponse; payer: string | undefined };

export interface Paywall {
  readonly config: Required<Pick<PaywallConfig, "facilitatorUrl" | "payTo" | "network" | "asset" | "maxTimeoutSeconds">>;
  requirements(price: string): PaymentRequirements;
  paymentRequired(price: string, resource: ResourceInfo, error?: string): PaymentRequired;
  handle(input: HandleInput): Promise<HandleResult>;
}

/**
 * Framework-agnostic x402 paywall for Stellar. Pay-first semantics: a request
 * carrying PAYMENT-SIGNATURE is verified and settled through the facilitator
 * before the resource handler runs; the settlement receipt is returned in the
 * PAYMENT-RESPONSE header. Without a valid payment the caller gets HTTP 402
 * with the PaymentRequired document in both the body and PAYMENT-REQUIRED.
 */
export function createPaywall(cfg: PaywallConfig): Paywall {
  const asset = cfg.asset ?? USDC_SAC[cfg.network];
  if (!asset) throw new Error(`No default asset for ${cfg.network}; pass asset explicitly`);
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const config = {
    facilitatorUrl: cfg.facilitatorUrl.replace(/\/$/, ""),
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
    const body = paymentRequired(price, resource, error);
    return {
      kind: "payment_required",
      status: 402,
      headers: { [HEADER_PAYMENT_REQUIRED]: encodeHeader(body), "content-type": "application/json" },
      body,
    };
  };

  async function callFacilitator<T>(
    path: "/verify" | "/settle",
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
    parse: (v: unknown) => T,
  ): Promise<T> {
    const res = await fetchImpl(`${config.facilitatorUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
    });
    if (!res.ok) throw new Error(`facilitator ${path} HTTP ${res.status}`);
    return parse(await res.json());
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

      let verify;
      try {
        verify = await callFacilitator("/verify", payload, expected, (v) => VerifyResponseSchema.parse(v));
      } catch (err) {
        return deny(price, resource, `facilitator_unreachable: ${(err as Error).message}`);
      }
      if (!verify.isValid) return deny(price, resource, verify.invalidReason ?? "payment_invalid");

      let settlement: SettleResponse;
      try {
        settlement = await callFacilitator("/settle", payload, expected, (v) => SettleResponseSchema.parse(v));
      } catch (err) {
        return deny(price, resource, `facilitator_unreachable: ${(err as Error).message}`);
      }
      if (!settlement.success) return deny(price, resource, settlement.errorReason ?? "settlement_failed");

      return {
        kind: "paid",
        headers: { [HEADER_PAYMENT_RESPONSE]: encodeHeader(settlement) },
        settlement,
        payer: settlement.payer ?? verify.payer,
      };
    },
  };
}
