import { Hono } from "hono";
import {
  buildManifest,
  createPaywall,
  honoPaywall,
  type ServiceInput,
} from "@genesis402/stellar-seller-sdk";

export const SELLER = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";
export const ORIGIN = "https://seller.example";

export interface MockSellerOptions {
  /** Service name -> behaviour override. "free" answers 200 without a 402; "lie" quotes a different payTo. */
  overrides?: Record<string, "free" | "lie">;
  network?: string;
}

/** A tiny seller: manifest at /.well-known/x402, two paid routes, optional misbehaviour for crawler tests. */
export function mockSeller(opts: MockSellerOptions = {}) {
  const pw = createPaywall({
    facilitatorUrl: "http://facilitator.local",
    payTo: SELLER,
    network: opts.network ?? "stellar:testnet",
    fetch: async () => Response.json({ isValid: false, invalidReason: "mock" }),
  });
  const services: ServiceInput[] = [
    {
      name: "weather",
      endpoint: `${ORIGIN}/weather`,
      title: "Weather",
      what_you_get: "Current conditions",
      price_usd: "0.01",
      category: "data",
    },
    {
      name: "quote",
      endpoint: `${ORIGIN}/quote`,
      method: "POST",
      title: "Quote",
      what_you_get: "A price quote",
      price_usd: "0.25",
      category: "finance",
    },
  ];
  const app = new Hono();
  app.get("/.well-known/x402", (c) =>
    c.json(
      buildManifest({
        provider: { name: "Mock Seller", operator: "Test", origin: ORIGIN, contact: "x@example.com" },
        paywall: pw,
        services,
        free_endpoints: ["/health"],
      }),
    ),
  );
  app.get("/health", (c) => c.json({ ok: true }));
  for (const s of services) {
    const mode = opts.overrides?.[s.name];
    const register = s.method === "POST" ? app.post.bind(app) : app.get.bind(app);
    const path = new URL(s.endpoint).pathname;
    if (mode === "free") {
      register(path, (c) => c.json({ free: true }));
    } else if (mode === "lie") {
      register(path, (c) => {
        const body = pw.paymentRequired(s.price_usd, { url: c.req.url });
        body.accepts[0]!.payTo = "GAPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAW";
        return c.json(body, 402);
      });
    } else {
      register(path, honoPaywall(pw, { price: s.price_usd }), (c) => c.json({ paid: true }));
    }
  }
  const fetchImpl: typeof fetch = (input, init) =>
    app.request(typeof input === "string" ? input : input instanceof URL ? input.href : input, init);
  return { app, fetchImpl, manifestUrl: `${ORIGIN}/.well-known/x402` };
}
