import { serve, type ServerType } from "@hono/node-server";
import { Horizon, Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RpcChainClient,
  SqliteNonceStore,
  StellarFacilitator,
  STELLAR_TESTNET,
  USDC_SAC,
  createApp,
  createPaymentPayload,
  decodeBase64Json,
  encodePaymentHeader,
  explorerTxUrl,
  type PaymentRequired,
  type SettleResponse,
} from "@genesis402/stellar-facilitator";
import { SqliteResourceIndex, createDiscoveryApp } from "@genesis402/stellar-discovery";
import { createSellerApp } from "@genesis402/example-reference-seller";
import { classicBalance, ensureFunded, issueDemoAsset, type DemoAsset, type TestnetContext } from "./testnet.js";

export interface DemoResult {
  network: string;
  asset: DemoAsset;
  facilitator: string;
  payer: string;
  seller: string;
  txHash: string;
  explorerUrl: string;
  settlement: SettleResponse;
  discovered: string[];
  replayRefused: boolean;
  payerBalanceBefore: string;
  payerBalanceAfter: string;
  sellerBalanceAfter: string;
}

interface DemoKeys {
  facilitator: string;
  payer: string;
  seller: string;
  issuer: string;
}

const KEYS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "demo-keys.json");

/** Fresh testnet keypairs per run, reused from demo-keys.json (gitignored) when present. */
function loadKeys(env: NodeJS.ProcessEnv, log: (s: string) => void): Record<keyof DemoKeys, Keypair> {
  const fromEnv = (name: string) => (env[name] ? Keypair.fromSecret(env[name]!) : undefined);
  let saved: Partial<DemoKeys> = {};
  if (existsSync(KEYS_PATH)) {
    saved = JSON.parse(readFileSync(KEYS_PATH, "utf8")) as DemoKeys;
    log(`reusing testnet keys from ${KEYS_PATH}`);
  }
  const pick = (k: keyof DemoKeys, envName: string) =>
    fromEnv(envName) ?? (saved[k] ? Keypair.fromSecret(saved[k]!) : Keypair.random());
  const keys = {
    facilitator: pick("facilitator", "DEMO_FACILITATOR_SECRET"),
    payer: pick("payer", "DEMO_PAYER_SECRET"),
    seller: pick("seller", "DEMO_SELLER_SECRET"),
    issuer: pick("issuer", "DEMO_ISSUER_SECRET"),
  };
  writeFileSync(
    KEYS_PATH,
    JSON.stringify(
      Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.secret()])),
      null,
      2,
    ),
  );
  return keys;
}

function listen(fetch: (req: Request) => Response | Promise<Response>): Promise<{ server: ServerType; url: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({ server, url: `http://127.0.0.1:${info.port}` });
    });
  });
}

/**
 * One real paid call on Stellar testnet:
 * fund accounts -> (issue TUSDC or use Circle testnet USDC) -> start facilitator,
 * seller and discovery in-process -> discovery crawls the seller -> payer gets a
 * 402 -> signs a Soroban auth entry -> seller verifies+settles via facilitator
 * -> 200 with PAYMENT-RESPONSE -> replay of the same payload is refused.
 */
export async function runTestnetDemo(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
): Promise<DemoResult> {
  const network = STELLAR_TESTNET;
  const rpcUrl = env["STELLAR_RPC_URL"] ?? "https://soroban-testnet.stellar.org";
  const horizonUrl = env["STELLAR_HORIZON_URL"] ?? "https://horizon-testnet.stellar.org";
  const ctx: TestnetContext = {
    server: new rpc.Server(rpcUrl),
    horizon: new Horizon.Server(horizonUrl),
    networkPassphrase: Networks.TESTNET,
    log,
  };
  const keys = loadKeys(env, log);
  log(`facilitator ${keys.facilitator.publicKey()}`);
  log(`payer       ${keys.payer.publicKey()}`);
  log(`seller      ${keys.seller.publicKey()}`);

  await Promise.all([
    ensureFunded(ctx, keys.facilitator.publicKey(), "facilitator"),
    ensureFunded(ctx, keys.payer.publicKey(), "payer"),
    ensureFunded(ctx, keys.seller.publicKey(), "seller"),
    ensureFunded(ctx, keys.issuer.publicKey(), "issuer"),
  ]);

  let asset: DemoAsset;
  if (env["DEMO_ASSET_CONTRACT"]) {
    asset = {
      contract: env["DEMO_ASSET_CONTRACT"],
      code: env["DEMO_ASSET_CODE"] ?? "USDC",
      issuer: env["DEMO_ASSET_ISSUER"] ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      label: env["DEMO_ASSET_CONTRACT"] === USDC_SAC[network] ? "REAL-TESTNET" : "DEMO",
    };
    log(`using asset ${asset.code} ${asset.contract} (${asset.label}); payer must already hold it`);
  } else {
    log("issuing DEMO asset TUSDC (Circle testnet USDC needs a manual faucet; see README)");
    asset = await issueDemoAsset(ctx, keys.issuer, keys.payer, keys.seller);
  }
  const payerBalanceBefore = await classicBalance(ctx, keys.payer.publicKey(), asset.code, asset.issuer);

  const facilitator = new StellarFacilitator({
    network,
    signer: keys.facilitator,
    chain: new RpcChainClient({ network, rpcUrl, horizonUrl }),
    nonceStore: new SqliteNonceStore(":memory:"),
    // Allowlist: Circle USDC always; the DEMO asset only because this demo issued it.
    allowedAssets: [USDC_SAC[network]!, asset.contract],
  });
  const fac = await listen(createApp(facilitator).fetch);
  log(`facilitator API ${fac.url}`);

  const seller = await listen(async (req) => sellerApp.fetch(req));
  const { app: sellerApp } = createSellerApp({
    facilitatorUrl: fac.url,
    payTo: keys.seller.publicKey(),
    network,
    asset: asset.contract,
    origin: seller.url,
  });
  log(`seller API      ${seller.url}`);

  // allowLocalTargets: the demo seller lives on 127.0.0.1; a public index must never set this.
  const discovery = await listen(
    createDiscoveryApp({ index: new SqliteResourceIndex(":memory:"), allowLocalTargets: true }).fetch,
  );
  log(`discovery API   ${discovery.url}`);

  try {
    const reg = await fetch(`${discovery.url}/discovery/sellers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest_url: `${seller.url}/.well-known/x402` }),
    });
    const { job_id } = (await reg.json()) as { job_id: string };
    let job: { status: string; listed?: number; skipped?: unknown[]; error?: string } = { status: "queued" };
    for (let i = 0; i < 200 && job.status !== "done" && job.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await (await fetch(`${discovery.url}/discovery/jobs/${job_id}`)).json()) as typeof job;
    }
    if (job.status !== "done") throw new Error(`discovery crawl ${job.status}: ${job.error ?? ""}`);
    log(`discovery crawled seller (job ${job_id}): listed=${job.listed} skipped=${JSON.stringify(job.skipped)}`);
    const listRes = await fetch(`${discovery.url}/discovery/resources?network=${network}`);
    const listed = (await listRes.json()) as { resources: Array<{ endpoint: string }> };
    const discovered = listed.resources.map((r) => r.endpoint);
    log(`GET /discovery/resources?network=${network} -> ${discovered.join(", ")}`);

    const target = `${seller.url}/weather?city=Atlanta`;
    const quoteRes = await fetch(target);
    if (quoteRes.status !== 402) throw new Error(`expected 402, got ${quoteRes.status}`);
    const quote = decodeBase64Json<PaymentRequired>(quoteRes.headers.get("PAYMENT-REQUIRED")!);
    const req = quote.accepts[0]!;
    log(`402 quote: ${req.amount} (atomic) ${asset.code} -> ${req.payTo} on ${req.network}, asset ${req.asset}`);

    const payload = await createPaymentPayload({
      payer: keys.payer.publicKey(),
      signer: keys.payer,
      requirements: req,
      rpc: ctx.server,
      resource: quote.resource,
    });
    log("payer signed a Soroban authorization entry for transfer(payer, seller, amount)");

    const paidRes = await fetch(target, { headers: { "PAYMENT-SIGNATURE": encodePaymentHeader(payload) } });
    const paidBody = (await paidRes.json()) as Record<string, unknown>;
    if (paidRes.status !== 200) throw new Error(`paid call failed: HTTP ${paidRes.status} ${JSON.stringify(paidBody)}`);
    const settlement = decodeBase64Json<SettleResponse>(paidRes.headers.get("PAYMENT-RESPONSE")!);
    const explorerUrl = explorerTxUrl(network, settlement.transaction);
    log(`200 OK body: ${JSON.stringify(paidBody)}`);
    log(`settled tx ${settlement.transaction}`);
    log(`explorer   ${explorerUrl}`);

    const replay = await fetch(target, { headers: { "PAYMENT-SIGNATURE": encodePaymentHeader(payload) } });
    const replayBody = (await replay.json()) as { error?: string };
    const replayRefused = replay.status === 402;
    log(`replay of the same payload -> HTTP ${replay.status} ${replayBody.error ?? ""}`);

    const payerBalanceAfter = await classicBalance(ctx, keys.payer.publicKey(), asset.code, asset.issuer);
    const sellerBalanceAfter = await classicBalance(ctx, keys.seller.publicKey(), asset.code, asset.issuer);
    log(`payer ${asset.code}: ${payerBalanceBefore} -> ${payerBalanceAfter}; seller ${asset.code}: ${sellerBalanceAfter}`);

    return {
      network,
      asset,
      facilitator: keys.facilitator.publicKey(),
      payer: keys.payer.publicKey(),
      seller: keys.seller.publicKey(),
      txHash: settlement.transaction,
      explorerUrl,
      settlement,
      discovered,
      replayRefused,
      payerBalanceBefore,
      payerBalanceAfter,
      sellerBalanceAfter,
    };
  } finally {
    fac.server.close();
    seller.server.close();
    discovery.server.close();
  }
}
