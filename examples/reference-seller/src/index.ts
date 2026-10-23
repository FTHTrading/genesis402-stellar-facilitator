import { Hono } from "hono";
import {
  buildManifest,
  createPaywall,
  honoPaywall,
  type Paywall,
  type ServiceInput,
} from "@genesis402/stellar-seller-sdk";

export interface SellerOptions {
  facilitatorUrl: string;
  /** Bearer token when the facilitator runs with SELLER_TOKENS. */
  facilitatorToken?: string;
  /** Seller's Stellar address that receives USDC. */
  payTo: string;
  network: string;
  /** Token contract; defaults to USDC on the network. */
  asset?: string;
  /** Public origin used in the manifest, e.g. http://localhost:4023 */
  origin: string;
  fetch?: typeof fetch;
}

export const SERVICES: ServiceInput[] = [
  {
    name: "weather",
    endpoint: "/weather",
    method: "GET",
    title: "Current weather for a city (demo data)",
    what_you_get: "JSON with city, temperature in Celsius and conditions. Demo values, not a live feed.",
    price_usd: "0.01",
    category: "data",
    input_schema: {
      type: "object",
      properties: { city: { type: "string", description: "query parameter ?city=" } },
    },
    output_schema: {
      type: "object",
      properties: {
        city: { type: "string" },
        tempC: { type: "number" },
        conditions: { type: "string" },
        paid_by: { type: "string" },
        tx: { type: "string" },
      },
      required: ["city", "tempC", "conditions"],
    },
  },
  {
    name: "echo",
    endpoint: "/echo",
    method: "POST",
    title: "Echo a JSON body back with a settlement receipt",
    what_you_get: "Your JSON body, the payer address and the Stellar transaction hash that paid for the call.",
    price_usd: "0.05",
    category: "utility",
    input_schema: { type: "object" },
    output_schema: {
      type: "object",
      properties: { echo: { type: "object" }, paid_by: { type: "string" }, tx: { type: "string" } },
    },
  },
];

/**
 * Reference seller: two paid routes behind the Stellar x402 paywall and a
 * `/.well-known/x402` manifest the discovery index can crawl.
 */
export function createSellerApp(opts: SellerOptions): { app: Hono; paywall: Paywall } {
  const paywall = createPaywall({
    facilitatorUrl: opts.facilitatorUrl,
    ...(opts.facilitatorToken ? { facilitatorToken: opts.facilitatorToken } : {}),
    payTo: opts.payTo,
    network: opts.network,
    ...(opts.asset ? { asset: opts.asset } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const origin = opts.origin.replace(/\/$/, "");
  const services = SERVICES.map((s) => ({ ...s, endpoint: `${origin}${s.endpoint}` }));

  const app = new Hono();
  app.get("/", (c) =>
    c.json({ name: "genesis402 reference seller", manifest: `${origin}/.well-known/x402`, services: services.map((s) => s.endpoint) }),
  );
  app.get("/health", (c) => c.json({ status: "ok", network: opts.network, payTo: opts.payTo }));
  app.get("/.well-known/x402", (c) =>
    c.json(
      buildManifest({
        provider: {
          name: "Genesis402 reference seller",
          operator: "UnyKorn LLC (Wyoming)",
          origin,
          contact: "kevan@unykorn.org",
        },
        paywall,
        services,
        free_endpoints: ["/health", "/.well-known/x402"],
      }),
    ),
  );

  const weather = services[0]!;
  app.get("/weather", honoPaywall(paywall, { price: weather.price_usd, description: weather.title }), (c) => {
    const city = c.req.query("city") ?? "Atlanta";
    const settlement = c.get("x402Settlement");
    return c.json({
      city,
      tempC: 21,
      conditions: "clear",
      paid_by: c.get("x402Payer"),
      tx: settlement.transaction,
      network: settlement.network,
    });
  });

  const echo = services[1]!;
  app.post("/echo", honoPaywall(paywall, { price: echo.price_usd, description: echo.title }), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const settlement = c.get("x402Settlement");
    return c.json({ echo: body, paid_by: c.get("x402Payer"), tx: settlement.transaction });
  });

  return { app, paywall };
}
