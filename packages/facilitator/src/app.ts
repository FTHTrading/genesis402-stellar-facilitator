import { createHash, timingSafeEqual } from "node:crypto";
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
   * seller's network). /supported advertises which mode is active. In bearer
   * mode a claim key is scoped to the token that presented it, so one seller
   * cannot read another seller's settlement outcome even with its key.
   */
  sellerTokens?: readonly string[];
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/**
 * x402 facilitator HTTP API:
 *   GET  /supported  -> { kinds, extensions, signers }  (kinds[].extra.sellerAuth: "open" | "bearer")
 *   POST /verify     -> { isValid, invalidReason?, payer? }
 *   POST /settle     -> { success, transaction, network, payer?, errorReason? }   (Idempotency-Key honoured)
 *                       429 fee_budget_exhausted / seller_fee_budget_exhausted / seller_rate_limited
 *   GET  /health
 * Error bodies carry fixed codes only; submitted values are never echoed.
 */
export function createApp(facilitator: StellarFacilitator, options: AppOptions = {}): Hono {
  const app = new Hono();
  const tokens = (options.sellerTokens ?? []).map((t) => t.trim()).filter(Boolean);
  const tokenHashes = tokens.map(sha256);
  const mode = tokens.length > 0 ? "bearer" : "open";
  app.use(
    "*",
    cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["content-type", "idempotency-key", "authorization"] }),
  );

  /** Returns the matched token (its digest) or undefined. Hash-then-compare: constant time, no length or index leak. */
  const authenticate = (c: Context): { ok: true; tokenId: string } | { ok: false } => {
    if (mode === "open") return { ok: true, tokenId: "" };
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) return { ok: false };
    const given = sha256(m[1]!);
    let matched: Buffer | undefined;
    for (const want of tokenHashes) {
      // Compare against every token so timing does not reveal which one matched.
      if (timingSafeEqual(want, given) && !matched) matched = want;
    }
    return matched ? { ok: true, tokenId: matched.toString("hex") } : { ok: false };
  };
  const unauthorized = (c: Context) => c.json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });

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
    if (!authenticate(c).ok) return unauthorized(c);
    const parsed = FacilitatorRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const { paymentPayload, paymentRequirements } = parsed.data;
    return c.json(await facilitator.verify(paymentPayload, paymentRequirements));
  });

  app.post("/settle", async (c) => {
    const auth = authenticate(c);
    if (!auth.ok) return unauthorized(c);
    const parsed = FacilitatorRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const { paymentPayload, paymentRequirements } = parsed.data;
    const key = c.req.header(HEADER_IDEMPOTENCY_KEY);
    // Scope the claim to the authenticated seller: the stored key is H(token || key), so another token with the same key never matches.
    const claimKey =
      key && CLAIM_KEY.test(key) ? (auth.tokenId ? createHash("sha256").update(`${auth.tokenId}|${key}`).digest("hex") : key) : undefined;
    const result = await facilitator.settle(paymentPayload, paymentRequirements, claimKey ? { claimKey } : {});
    if (
      result.errorReason === "fee_budget_exhausted" ||
      result.errorReason === "seller_fee_budget_exhausted" ||
      result.errorReason === "seller_rate_limited"
    ) {
      return c.json(result, 429, { "retry-after": "600" });
    }
    return c.json(result);
  });

  return app;
}
