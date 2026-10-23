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
 *   FEE_BUDGET_PER_SELLER_STROOPS_PER_HOUR  one payTo's share of that hour (default: a quarter of the global budget)
 *   MAX_SETTLES_PER_SELLER_PER_HOUR  per-payTo settlement cap (default 600)
 *   SELLER_TOKENS              comma-separated bearer tokens; set = sellers must authenticate, unset = open
 *   PORT                       default 4021
 * Every numeric value must be a plain non-negative integer ("5000000", not "5,000,000" or "0.5 XLM");
 * anything else refuses to start, the same way a bad allowlist does.
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
  // Fail closed: an ALLOWED_ASSETS that is set but names nothing is a misconfiguration, not "allow everything".
  const allowed = (env["ALLOWED_ASSETS"] ?? USDC_SAC[network] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const demo = env["DEMO_ASSET"]?.trim();
  if (demo) allowed.push(demo);
  const maxFee = envInt(env, "MAX_TRANSACTION_FEE_STROOPS");
  const feeBudget = envInt(env, "FEE_BUDGET_STROOPS_PER_HOUR");
  const perSeller = envInt(env, "FEE_BUDGET_PER_SELLER_STROOPS_PER_HOUR");
  const sellerCap = envInt(env, "MAX_SETTLES_PER_SELLER_PER_HOUR");
  return new StellarFacilitator({
    network,
    signer: Keypair.fromSecret(secret),
    chain,
    nonceStore: new SqliteNonceStore(env["NONCE_DB_PATH"] ?? "./facilitator-nonces.sqlite"),
    allowedAssets: allowed,
    ...(maxFee !== undefined ? { maxTransactionFeeStroops: maxFee } : {}),
    ...(feeBudget !== undefined ? { feeBudgetStroopsPerHour: feeBudget } : {}),
    ...(perSeller !== undefined ? { feeBudgetPerSellerStroopsPerHour: perSeller } : {}),
    ...(sellerCap !== undefined ? { maxSettlesPerSellerPerHour: sellerCap } : {}),
  });
}

/** Strict non-negative integer from the environment; unset/blank = undefined; anything else throws. */
export function envInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = raw.trim();
  if (!/^\d{1,15}$/.test(v)) {
    throw new Error(`${name} must be a plain non-negative integer (got "${v}")`);
  }
  return Number(v);
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
  const port = envInt(process.env, "PORT") ?? 4021;
  serve({ fetch: createApp(facilitator, { sellerTokens }).fetch, port }, (info) => {
    console.log(
      `genesis402-stellar-facilitator listening on http://localhost:${info.port} (${facilitator.network}, signer ${facilitator.address}, assets ${[...facilitator.allowedAssets].join(",")}, sellerAuth ${sellerTokens.length ? "bearer" : "open"})`,
    );
  });
}
