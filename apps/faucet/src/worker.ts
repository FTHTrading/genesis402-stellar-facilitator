import asset from "../testnet-asset.json";
import { createFaucet, type FaucetConfig } from "./faucet.js";
import { ClaimLimiter, globalLimitsFromEnv, type SqlDb } from "./ratelimit.js";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** wrangler secret; never logged, never returned. */
  DISTRIBUTOR_SECRET?: string;
  CLAIMS_PER_ADDRESS?: string;
  CLAIMS_PER_IP?: string;
  /** Global G402T claims per UTC day (default 1000). */
  G402T_CLAIMS_PER_DAY?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const config: FaucetConfig = {
  networkPassphrase: asset.networkPassphrase,
  horizonUrl: asset.horizonUrl,
  friendbotUrl: asset.friendbotUrl,
  explorerTxBase: asset.explorerTxBase,
  asset: asset.asset,
  distributor: asset.distributor,
  xlmSac: asset.xlmSac,
  usdc: asset.usdc,
};

if (config.networkPassphrase !== "Test SDF Network ; September 2015") {
  throw new Error("faucet refuses to start: testnet-asset.json is not a testnet configuration");
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

let cached: { env: Env; faucet: ReturnType<typeof createFaucet> } | null = null;

function faucetFor(env: Env) {
  if (cached?.env === env) return cached.faucet;
  const limiter = new ClaimLimiter(env.DB as unknown as SqlDb, {
    windowMs: DAY_MS,
    perAddress: positiveInt(env.CLAIMS_PER_ADDRESS, 1),
    perIp: positiveInt(env.CLAIMS_PER_IP, 1),
    globalPerDay: globalLimitsFromEnv(env.G402T_CLAIMS_PER_DAY),
  });
  const faucet = createFaucet({
    config,
    limiter,
    fetch: (input, init) => fetch(input, init),
    distributorSecret: env.DISTRIBUTOR_SECRET,
    now: () => Date.now(),
    log: (line) => console.log(line),
  });
  cached = { env, faucet };
  return faucet;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) return faucetFor(env).handle(request);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
