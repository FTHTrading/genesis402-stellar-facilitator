import { serve } from "@hono/node-server";
import { createSellerApp } from "./index.js";

/**
 * Standalone reference seller.
 *   FACILITATOR_URL   e.g. http://localhost:4021
 *   SELLER_ADDRESS    G... that receives USDC
 *   STELLAR_NETWORK   stellar:testnet (default)
 *   ASSET_CONTRACT    optional token contract (default USDC on the network)
 *   PORT              default 4023
 */
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const port = Number(process.env["PORT"] ?? 4023);
  const payTo = process.env["SELLER_ADDRESS"];
  if (!payTo) throw new Error("SELLER_ADDRESS is required");
  const asset = process.env["ASSET_CONTRACT"];
  const { app } = createSellerApp({
    facilitatorUrl: process.env["FACILITATOR_URL"] ?? "http://localhost:4021",
    payTo,
    network: process.env["STELLAR_NETWORK"] ?? "stellar:testnet",
    ...(asset ? { asset } : {}),
    origin: process.env["SELLER_ORIGIN"] ?? `http://localhost:${port}`,
  });
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`reference seller listening on http://localhost:${info.port}`);
  });
}
