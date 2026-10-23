import { Hono } from "hono";
import { cors } from "hono/cors";
import type { StellarFacilitator } from "./facilitator.js";
import { FacilitatorRequestSchema } from "./types.js";

/**
 * x402 facilitator HTTP API:
 *   GET  /supported  -> { kinds, extensions, signers }
 *   POST /verify     -> { isValid, invalidReason?, payer? }
 *   POST /settle     -> { success, transaction, network, payer?, errorReason? }
 *   GET  /health
 */
export function createApp(facilitator: StellarFacilitator): Hono {
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

  app.get("/", (c) =>
    c.json({
      name: "genesis402-stellar-facilitator",
      network: facilitator.network,
      endpoints: ["/supported", "/verify", "/settle", "/health"],
    }),
  );

  app.get("/health", (c) =>
    c.json({ status: "ok", network: facilitator.network, signer: facilitator.address }),
  );

  app.get("/supported", (c) => c.json(facilitator.supported()));

  app.post("/verify", async (c) => {
    const parsed = FacilitatorRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const { paymentPayload, paymentRequirements } = parsed.data;
    return c.json(await facilitator.verify(paymentPayload, paymentRequirements));
  });

  app.post("/settle", async (c) => {
    const parsed = FacilitatorRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const { paymentPayload, paymentRequirements } = parsed.data;
    return c.json(await facilitator.settle(paymentPayload, paymentRequirements));
  });

  return app;
}
