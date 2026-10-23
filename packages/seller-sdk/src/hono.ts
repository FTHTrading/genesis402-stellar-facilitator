import type { Context, MiddlewareHandler } from "hono";
import type { Paywall } from "./paywall.js";
import type { SettleResponse } from "./x402.js";

export interface HonoPaywallOptions {
  price: string;
  description?: string;
  mimeType?: string;
}

declare module "hono" {
  interface ContextVariableMap {
    x402Settlement: SettleResponse;
    x402Payer: string | undefined;
  }
}

/**
 * Hono middleware: `app.get("/weather", honoPaywall(pw, { price: "0.01" }), handler)`.
 * On success the settlement is available as `c.get("x402Settlement")` and the
 * PAYMENT-RESPONSE header is added to the handler's response.
 */
export function honoPaywall(paywall: Paywall, opts: HonoPaywallOptions): MiddlewareHandler {
  return async (c: Context, next) => {
    const result = await paywall.handle({
      price: opts.price,
      resource: {
        url: c.req.url,
        ...(opts.description ? { description: opts.description } : {}),
        mimeType: opts.mimeType ?? "application/json",
      },
      headers: c.req.raw.headers,
    });
    if (result.kind === "payment_required") {
      return c.json(result.body, 402, result.headers);
    }
    if (result.kind === "settlement_pending") {
      return c.json(result.body, 409, result.headers);
    }
    c.set("x402Settlement", result.settlement);
    c.set("x402Payer", result.payer);
    await next();
    for (const [k, v] of Object.entries(result.headers)) c.res.headers.set(k, v);
  };
}
