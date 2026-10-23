import { z } from "zod";
import type { Paywall } from "./paywall.js";
import { PaymentRequirementsSchema } from "./x402.js";

/**
 * `/.well-known/x402` manifest. Field names follow the live Genesis402 rail
 * (twin.unykorn.org/.well-known/x402, x402Version 2) and carry the Bazaar-style
 * per-service fields a discovery index needs: endpoint, method, price_usd,
 * accepts[], and optional input/output JSON schemas.
 */
export const ManifestServiceSchema = z.object({
  name: z.string().min(1),
  endpoint: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  title: z.string().min(1),
  what_you_get: z.string().min(1),
  price_usd: z.string().regex(/^\d+(\.\d+)?$/),
  category: z.string().optional(),
  accepts: z.array(PaymentRequirementsSchema).min(1),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
});
export type ManifestService = z.infer<typeof ManifestServiceSchema>;

export const ManifestSchema = z.object({
  x402Version: z.literal(2),
  provider: z.object({
    name: z.string().min(1),
    operator: z.string().min(1),
    origin: z.string().url(),
    contact: z.string().min(1),
  }),
  status: z.enum(["live", "testnet", "maintenance"]),
  services: z.array(ManifestServiceSchema),
  accepts: z.array(PaymentRequirementsSchema),
  free_endpoints: z.array(z.string()).optional(),
  generated_at: z.string(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export interface ServiceInput {
  name: string;
  endpoint: string;
  method?: ManifestService["method"];
  title: string;
  what_you_get: string;
  price_usd: string;
  category?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

export interface ManifestInput {
  provider: Manifest["provider"];
  paywall: Paywall;
  services: ServiceInput[];
  free_endpoints?: string[];
  status?: Manifest["status"];
}

export function buildManifest(input: ManifestInput): Manifest {
  const services: ManifestService[] = input.services.map((s) => ({
    name: s.name,
    endpoint: s.endpoint,
    method: s.method ?? "GET",
    title: s.title,
    what_you_get: s.what_you_get,
    price_usd: s.price_usd,
    ...(s.category ? { category: s.category } : {}),
    accepts: [input.paywall.requirements(s.price_usd)],
    ...(s.input_schema ? { input_schema: s.input_schema } : {}),
    ...(s.output_schema ? { output_schema: s.output_schema } : {}),
  }));
  const status = input.status ?? (input.paywall.config.network === "stellar:pubnet" ? "live" : "testnet");
  const cheapest = services.length
    ? services.reduce((a, b) => (BigInt(a.accepts[0]!.amount) <= BigInt(b.accepts[0]!.amount) ? a : b))
    : undefined;
  return {
    x402Version: 2,
    provider: input.provider,
    status,
    services,
    accepts: cheapest ? [cheapest.accepts[0]!] : [],
    ...(input.free_endpoints ? { free_endpoints: input.free_endpoints } : {}),
    generated_at: new Date().toISOString(),
  };
}
