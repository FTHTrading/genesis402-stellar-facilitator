import { serve } from "@hono/node-server";
import { realpathSync } from "node:fs";
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
 *   MAX_TRANSACTION_FEE_STROOPS  fee ceiling per settlement (default 50000)
 *   FEE_BUDGET_STROOPS_PER_HOUR  fee-drain guard: total fees sponsored per trailing hour (default 5000000)
 *   MAX_SETTLES_PER_SELLER_PER_HOUR  per-payTo settlement cap (default 600)
 *   SELLER_TOKENS              comma-separated bearer tokens; set = sellers must authenticate, unset = open
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
  // Fail closed: an ALLOWED_ASSETS that is set but names nothing is a misconfiguration, not "allow everything".
  const allowed = (env["ALLOWED_ASSETS"] ?? USDC_SAC[network] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const demo = env["DEMO_ASSET"]?.trim();
  if (demo) allowed.push(demo);
  const feeBudget = env["FEE_BUDGET_STROOPS_PER_HOUR"];
  const sellerCap = env["MAX_SETTLES_PER_SELLER_PER_HOUR"];
  return new StellarFacilitator({
    network,
    signer: Keypair.fromSecret(secret),
    chain,
    nonceStore: new SqliteNonceStore(env["NONCE_DB_PATH"] ?? "./facilitator-nonces.sqlite"),
    allowedAssets: allowed,
    ...(maxFee ? { maxTransactionFeeStroops: Number(maxFee) } : {}),
    ...(feeBudget ? { feeBudgetStroopsPerHour: Number(feeBudget) } : {}),
    ...(sellerCap ? { maxSettlesPerSellerPerHour: Number(sellerCap) } : {}),
  });
}

/** SELLER_TOKENS: comma-separated bearer tokens; empty or unset = open API (self-host default). */
export function sellerTokensFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env["SELLER_TOKENS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Main-module guard that holds on Windows (C:\...) and POSIX (/home/...) under node and tsx, and through symlinks.
try {
  if (process.argv[1]) process.argv[1] = realpathSync(process.argv[1]);
} catch {
  /* leave argv[1] as given */
}
if (process.argv[1] && import.meta.url === new URL("file:///" + process.argv[1].replace(/\\/g, "/").replace(/^\/+/, "")).href) {
  const facilitator = facilitatorFromEnv();
  const sellerTokens = sellerTokensFromEnv();
  const port = Number(process.env["PORT"] ?? 4021);
  serve({ fetch: createApp(facilitator, { sellerTokens }).fetch, port }, (info) => {
    console.log(
      `genesis402-stellar-facilitator listening on http://localhost:${info.port} (${facilitator.network}, signer ${facilitator.address}, assets ${[...facilitator.allowedAssets].join(",")}, sellerAuth ${sellerTokens.length ? "bearer" : "open"})`,
    );
  });
}
