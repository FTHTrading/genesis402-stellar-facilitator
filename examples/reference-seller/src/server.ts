import { serve } from "@hono/node-server";
import { realpathSync } from "node:fs";
import { createSellerApp } from "./index.js";

/**
 * Standalone reference seller.
 *   FACILITATOR_URL   e.g. http://localhost:4021
 *   FACILITATOR_TOKEN bearer token, required when the facilitator runs with SELLER_TOKENS
 *   SELLER_ADDRESS    G... that receives USDC
 *   STELLAR_NETWORK   stellar:testnet (default)
 *   ASSET_CONTRACT    optional token contract (default USDC on the network)
 *   PORT              default 4023
 */
// Main-module guard that holds on Windows (C:\...) and POSIX (/home/...) under node and tsx, and through symlinks.
try {
  if (process.argv[1]) process.argv[1] = realpathSync(process.argv[1]);
} catch {
  /* leave argv[1] as given */
}
if (process.argv[1] && import.meta.url === new URL("file:///" + process.argv[1].replace(/\\/g, "/").replace(/^\/+/, "")).href) {
  const port = Number(process.env["PORT"] ?? 4023);
  const payTo = process.env["SELLER_ADDRESS"];
  if (!payTo) throw new Error("SELLER_ADDRESS is required");
  const asset = process.env["ASSET_CONTRACT"];
  const token = process.env["FACILITATOR_TOKEN"]?.trim();
  const { app } = createSellerApp({
    facilitatorUrl: process.env["FACILITATOR_URL"] ?? "http://localhost:4021",
    ...(token ? { facilitatorToken: token } : {}),
    payTo,
    network: process.env["STELLAR_NETWORK"] ?? "stellar:testnet",
    ...(asset ? { asset } : {}),
    origin: process.env["SELLER_ORIGIN"] ?? `http://localhost:${port}`,
  });
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`reference seller listening on http://localhost:${info.port}`);
  });
}
