import { serve } from "@hono/node-server";
import { Keypair } from "@stellar/stellar-sdk";
import { createApp } from "./app.js";
import { RpcChainClient } from "./chain.js";
import { STELLAR_TESTNET } from "./constants.js";
import { StellarFacilitator } from "./facilitator.js";
import { SqliteNonceStore } from "./nonce-store.js";

/**
 * Standalone facilitator process. Configuration (see .env.example):
 *   STELLAR_NETWORK            stellar:testnet (default) | stellar:pubnet
 *   FACILITATOR_SECRET         S... secret of the fee-paying settlement account (required)
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
  return new StellarFacilitator({
    network,
    signer: Keypair.fromSecret(secret),
    chain,
    nonceStore: new SqliteNonceStore(env["NONCE_DB_PATH"] ?? "./facilitator-nonces.sqlite"),
    ...(maxFee ? { maxTransactionFeeStroops: Number(maxFee) } : {}),
  });
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const facilitator = facilitatorFromEnv();
  const port = Number(process.env["PORT"] ?? 4021);
  serve({ fetch: createApp(facilitator).fetch, port }, (info) => {
    console.log(
      `genesis402-stellar-facilitator listening on http://localhost:${info.port} (${facilitator.network}, signer ${facilitator.address})`,
    );
  });
}
