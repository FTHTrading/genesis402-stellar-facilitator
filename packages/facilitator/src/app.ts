import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { StellarFacilitator } from "./facilitator.js";
import { FacilitatorRequestSchema } from "./types.js";

/** Header a seller sends on /settle to identify its claim; a retry with the same key reads the same outcome. */
export const HEADER_IDEMPOTENCY_KEY = "idempotency-key";
const CLAIM_KEY = /^[A-Za-z0-9_-]{8,128}$/;

export interface AppOptions {
  /**
   * Seller authentication (threat model Elevation.4). When non-empty, /verify
   * and /settle require `Authorization: Bearer <token>` with one of these
   * tokens; when empty the API is open (self-host default, put it behind the
   * seller's network). /supported advertises which mode is active.
   */
  sellerTokens?: readonly string[];
}

/**
 * x402 facilitator HTTP API:
 *   GET  /supported  -> { kinds, extensions, signers }  (kinds[].extra.sellerAuth: "open" | "bearer")
 *   POST /verify     -> { isValid, invalidReason?, payer? }
 *   POST /settle     -> { success, transaction, network, payer?, errorReason? }   (Idempotency-Key honoured)
 *                       429 fee_budget_exhausted / seller_rate_limited when the fee-drain guard refuses
 *   GET  /health
 * Error bodies carry fixed codes only; submitted values are never echoed.
 */
export function createApp(facilitator: StellarFacilitator, options: AppOptions = {}): Hono {
  const app = new Hono();
  const tokens = (options.sellerTokens ?? []).map((t) => t.trim()).filter(Boolean);
  const mode = tokens.length > 0 ? "bearer" : "open";
  app.use(
    "*",
    cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["content-type", "idempotency-key", "authorization"] }),
  );

  const authorized = (c: Context): boolean => {
    if (mode === "open") return true;
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) return false;
    const given = Buffer.from(m[1]!);
    return tokens.some((t) => {
      const want = Buffer.from(t);
      return want.length === given.length && timingSafeEqual(want, given);
    });
  };

  app.get("/", (c) =>
    c.json({
      name: "genesis402-stellar-facilitator",
      network: facilitator.network,
      sellerAuth: mode,
      endpoints: ["/supported", "/verify", "/settle", "/health"],
    }),
  );

  app.get("/health", (c) =>
    c.json({ status: "ok", network: facilitator.network, signer: facilitator.address, sellerAuth: mode, ...facilitator.usage() }),
  );

  app.get("/supported", (c) => {
    const s = facilitator.supported();
    return c.json({ ...s, kinds: s.kinds.map((k) => ({ ...k, extra: { ...k.extra, sellerAuth: mode } })) });
  });

  app.post("/verify", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    const parsed = FacilitatorRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const { paymentPayload, paymentRequirements } = parsed.data;
    return c.json(await facilitator.verify(paymentPayload, paymentRequirements));
  });

  app.post("/settle", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    const parsed = FacilitatorRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const { paymentPayload, paymentRequirements } = parsed.data;
    const key = c.req.header(HEADER_IDEMPOTENCY_KEY);
    const claimKey = key && CLAIM_KEY.test(key) ? key : undefined;
    const result = await facilitator.settle(paymentPayload, paymentRequirements, claimKey ? { claimKey } : {});
    if (result.errorReason === "fee_budget_exhausted" || result.errorReason === "seller_rate_limited") {
      return c.json(result, 429, { "retry-after": "600" });
    }
    return c.json(result);
  });

  return app;
}
