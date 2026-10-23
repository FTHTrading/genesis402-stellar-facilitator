import { PaymentRequirementsSchema } from "@genesis402/stellar-seller-sdk";
import { z } from "zod";

/**
 * One listed x402 resource. A record exists only after the index itself
 * received a valid HTTP 402 quote from `endpoint` that agrees with the seller's
 * manifest entry (`quote_verified_at`). Field names follow the Bazaar pattern:
 * what is sold, where, for how much, on which chain and asset, with schemas.
 */
export const ResourceRecordSchema = z.object({
  /** `${network}|${method}|${endpoint}` */
  id: z.string().min(1),
  seller_origin: z.string().url(),
  manifest_url: z.string().url(),
  name: z.string().min(1),
  endpoint: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  title: z.string().min(1),
  what_you_get: z.string().min(1),
  price_usd: z.string().regex(/^\d+(\.\d+)?$/),
  category: z.string().optional(),
  scheme: z.string().min(1),
  /** CAIP-2, e.g. stellar:testnet */
  network: z.string().min(1),
  /** Token contract address */
  asset: z.string().min(1),
  /** Atomic amount quoted in the live 402 */
  amount: z.string().regex(/^\d+$/),
  payTo: z.string().min(1),
  /** The full accepts[] from the live 402, so buyers see every lane the seller offers. */
  accepts: z.array(PaymentRequirementsSchema),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  /** ISO time the index last received a valid 402 from this endpoint. */
  quote_verified_at: z.string(),
  first_seen: z.string(),
  last_seen: z.string(),
});
export type ResourceRecord = z.infer<typeof ResourceRecordSchema>;

/** JSON Schema (draft 2020-12) for mirrors and other indexes. */
export function resourceRecordJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ResourceRecordSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
}

export const RegisterSellerSchema = z.object({
  manifest_url: z.string().url(),
});

export interface ResourceQuery {
  network?: string;
  /** Inclusive upper bound on atomic `amount`. */
  maxAmount?: string;
  category?: string;
  seller?: string;
  /** Case-insensitive substring over name, title and what_you_get. */
  q?: string;
  limit?: number;
}
