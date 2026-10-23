import { serve } from "@hono/node-server";
import { Keypair } from "@stellar/stellar-sdk";
import { createApp } from "./app.js";
import { RpcChainClient } from "./chain.js";
import { STELLAR_TESTNET, USDC_SAC } from "./constants.js";
import { StellarFacilitator } from "./facilitator.js";
import { SqliteNonceStore } from "./nonce-store.js";

/**
 * Standalone facilitator process. Configuration (see .env.example):
 *   STELLAR_NETWORK            stellar:testnet (default) | stellar:pubnet
 *   FACILITATOR_SECRET         S... secret of the fee-paying settlement account (required)
 *   ALLOWED_ASSETS             comma-separated token contracts to sponsor (default: Circle USDC on the network)
 *   DEMO_ASSET                 one extra contract added to the allowlist for demos (never set on a public instance)
 *   STELLAR_RPC_URL            Soroban RPC (default: SDF testnet RPC)
 *   STELLAR_HORIZON_URL        Horizon (default per network)
 *   NONCE_DB_PATH              SQLite file for consumed nonces (default: ./facilitator-nonces.sqlite)
 *   MAX_TRANSACTION_FEE_STROOPS  fee ceiling (default 50000)
 *   PORT                       default 4021
 */
export function facilitatorFromEnv(env: NodeJS.ProcessEnv = process.env): StellarFacilitator {
  const network = env["STELLAR_NETWORK"] ?? STELLAR_TESTNET;
  const secret = env["FACILITATOR_SECRET"];
  if (!secret) throw new Error("FACILITATOR_SECRET is required (testnet S... secret; never commit it)");
  const chain = new RpcChainClient({
    network,
    ...(env["STELLAR_RPC_URL"] ? { rpcUrl: env["STELLAR_RPC_URL"] } : {}),
    ...(env["STELLAR_HORIZON_URL"] ? { horizonUrl: env["STELLAR_HORIZON_URL"] } : {}),
  });
  const maxFee = env["MAX_TRANSACTION_FEE_STROOPS"];
  const allowed = (env["ALLOWED_ASSETS"] ?? USDC_SAC[network] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (env["DEMO_ASSET"]) allowed.push(env["DEMO_ASSET"].trim());
  return new StellarFacilitator({
    network,
    signer: Keypair.fromSecret(secret),
    chain,
    nonceStore: new SqliteNonceStore(env["NONCE_DB_PATH"] ?? "./facilitator-nonces.sqlite"),
    allowedAssets: allowed,
    ...(maxFee ? { maxTransactionFeeStroops: Number(maxFee) } : {}),
  });
}

// Main-module guard that holds on Windows (C:\...) and POSIX (/home/...) under node and tsx.
if (process.argv[1] && import.meta.url === new URL("file:///" + process.argv[1].replace(/\\/g, "/").replace(/^\/+/, "")).href) {
  const facilitator = facilitatorFromEnv();
  const port = Number(process.env["PORT"] ?? 4021);
  serve({ fetch: createApp(facilitator).fetch, port }, (info) => {
    console.log(
      `genesis402-stellar-facilitator listening on http://localhost:${info.port} (${facilitator.network}, signer ${facilitator.address}, assets ${[...facilitator.allowedAssets].join(",")})`,
    );
  });
}
