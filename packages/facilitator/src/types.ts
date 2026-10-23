import { z } from "zod";

/** x402 v2 PaymentRequirements (one entry of `accepts`). */
export const PaymentRequirementsSchema = z.object({
  scheme: z.string().min(1),
  network: z.string().regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/, "CAIP-2 network id"),
  amount: z.string().regex(/^\d+$/, "atomic integer amount"),
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

/** Stellar `exact` payload: one base64 transaction XDR with signed auth entries. */
export const ExactStellarPayloadSchema = z.object({
  transaction: z.string().min(1),
});
export type ExactStellarPayload = z.infer<typeof ExactStellarPayloadSchema>;

/** x402 v2 PaymentPayload as carried in PAYMENT-SIGNATURE. */
export const PaymentPayloadSchema = z.object({
  x402Version: z.number().int(),
  resource: ResourceInfoSchema.optional(),
  accepted: PaymentRequirementsSchema,
  payload: z.record(z.string(), z.unknown()),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

/** x402 v2 PaymentRequired (402 body and PAYMENT-REQUIRED header). */
export const PaymentRequiredSchema = z.object({
  x402Version: z.literal(2),
  error: z.string().optional(),
  resource: ResourceInfoSchema,
  accepts: z.array(PaymentRequirementsSchema).min(1),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;

/** Body of POST /verify and POST /settle. */
export const FacilitatorRequestSchema = z.object({
  x402Version: z.number().int().optional(),
  paymentPayload: PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
});
export type FacilitatorRequest = z.infer<typeof FacilitatorRequestSchema>;

/** Responses carry fixed reason codes only; causes are logged server-side, never returned. */
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  /** Tx hash when an envelope was submitted (or a replay names the one that consumed the entry); else "". */
  transaction: string;
  network: string;
  payer?: string;
  amount?: string;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
}

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
