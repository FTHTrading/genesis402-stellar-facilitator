import { z } from "zod";

/**
 * x402 v2 wire format (https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)
 * and the Stellar `exact` scheme (specs/schemes/exact/scheme_exact_stellar.md).
 */

export const PaymentRequirementsSchema = z.object({
  scheme: z.string().min(1),
  network: z.string().regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/),
  amount: z.string().regex(/^\d+$/),
  asset: z.string().min(1),
  payTo: z.string().min(1),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

export const ResourceInfoSchema = z.object({
  url: z.string().min(1),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});
export type ResourceInfo = z.infer<typeof ResourceInfoSchema>;

export const PaymentRequiredSchema = z.object({
  x402Version: z.literal(2),
  error: z.string().optional(),
  resource: ResourceInfoSchema,
  accepts: z.array(PaymentRequirementsSchema).min(1),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;

export const PaymentPayloadSchema = z.object({
  x402Version: z.number().int(),
  resource: ResourceInfoSchema.optional(),
  accepted: PaymentRequirementsSchema,
  payload: z.record(z.string(), z.unknown()),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

export const VerifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  invalidMessage: z.string().optional(),
  payer: z.string().optional(),
});
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;

export const SettleResponseSchema = z.object({
  success: z.boolean(),
  errorReason: z.string().optional(),
  errorMessage: z.string().optional(),
  transaction: z.string(),
  network: z.string(),
  payer: z.string().optional(),
  amount: z.string().optional(),
});
export type SettleResponse = z.infer<typeof SettleResponseSchema>;

export const SupportedResponseSchema = z.object({
  kinds: z
    .array(
      z.object({
        x402Version: z.number().int(),
        scheme: z.string(),
        network: z.string(),
        extra: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1),
  extensions: z.array(z.string()),
  signers: z.record(z.string(), z.array(z.string())),
});
export type SupportedResponse = z.infer<typeof SupportedResponseSchema>;

/** Header names. The request-side header is PAYMENT-SIGNATURE; X-PAYMENT is accepted for v1-era clients. */
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_LEGACY = "X-PAYMENT";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader<T = unknown>(value: string): T {
  const text = Buffer.from(value, "base64").toString("utf8");
  return JSON.parse(text) as T;
}

/** Stellar network constants duplicated here so sellers do not need the Stellar SDK. */
export const STELLAR_TESTNET = "stellar:testnet";
export const STELLAR_PUBNET = "stellar:pubnet";
export const USDC_SAC: Readonly<Record<string, string>> = {
  [STELLAR_TESTNET]: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  [STELLAR_PUBNET]: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
};
export const USDC_DECIMALS = 7;

/** Exact decimal-string to atomic-unit conversion; no floating point. */
export function usdToAtomic(price: string, decimals = USDC_DECIMALS): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(price.trim());
  if (!m) throw new Error(`Invalid price "${price}": expected a non-negative decimal string`);
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (frac.length > decimals) {
    throw new Error(`Price "${price}" has more than ${decimals} decimal places`);
  }
  const atomic = BigInt(whole + frac.padEnd(decimals, "0"));
  if (atomic <= 0n) throw new Error(`Price "${price}" must be greater than zero`);
  return atomic.toString();
}
