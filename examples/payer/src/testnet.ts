import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { FRIENDBOT_URL } from "@genesis402/stellar-facilitator";

export interface TestnetContext {
  server: rpc.Server;
  horizon: Horizon.Server;
  networkPassphrase: string;
  log: (line: string) => void;
}

/** Funds an account with friendbot unless it already exists. */
export async function ensureFunded(ctx: TestnetContext, publicKey: string, label: string): Promise<void> {
  try {
    await ctx.server.getAccount(publicKey);
    ctx.log(`${label} ${publicKey} already funded`);
    return;
  } catch {
    /* not found: fund it */
  }
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(`friendbot failed for ${label}: HTTP ${res.status} ${await res.text()}`);
  }
  await ctx.server.getAccount(publicKey);
  ctx.log(`${label} ${publicKey} funded by friendbot`);
}

/** Classic (non-Soroban) operations are submitted through Horizon, which waits for inclusion. */
export async function submitClassic(
  ctx: TestnetContext,
  source: Keypair,
  ops: ReturnType<typeof Operation.payment>[],
  label: string,
): Promise<string> {
  const account = await ctx.horizon.loadAccount(source.publicKey());
  const builder = new TransactionBuilder(account, { fee: (Number(BASE_FEE) * 10).toString(), networkPassphrase: ctx.networkPassphrase });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(60).build();
  tx.sign(source);
  const res = await ctx.horizon.submitTransaction(tx);
  ctx.log(`${label}: ${res.hash}`);
  return res.hash;
}

export interface DemoAsset {
  /** SEP-41 contract address used in x402 requirements. */
  contract: string;
  code: string;
  issuer: string;
  /** DEMO when issued by this script; REAL-TESTNET when it is Circle's testnet USDC. */
  label: "DEMO" | "REAL-TESTNET";
}

/**
 * Issues a test asset `TUSDC` from `issuer`, gives `payer` a balance, opens a
 * trustline for `seller`, and deploys the asset's Stellar Asset Contract so
 * SEP-41 `transfer` can be invoked through Soroban. Everything here is DEMO:
 * TUSDC is not USDC and has no value.
 */
export async function issueDemoAsset(
  ctx: TestnetContext,
  issuer: Keypair,
  payer: Keypair,
  seller: Keypair,
  payerAmount = "100",
): Promise<DemoAsset> {
  const asset = new Asset("TUSDC", issuer.publicKey());
  await submitClassic(ctx, payer, [Operation.changeTrust({ asset })], "payer trustline TUSDC");
  await submitClassic(ctx, seller, [Operation.changeTrust({ asset })], "seller trustline TUSDC");
  await submitClassic(
    ctx,
    issuer,
    [Operation.payment({ destination: payer.publicKey(), asset, amount: payerAmount })],
    `issuer paid ${payerAmount} TUSDC to payer`,
  );
  const contract = asset.contractId(ctx.networkPassphrase);
  await deploySac(ctx, issuer, asset, contract);
  return { contract, code: "TUSDC", issuer: issuer.publicKey(), label: "DEMO" };
}

async function deploySac(ctx: TestnetContext, source: Keypair, asset: Asset, contract: string): Promise<void> {
  const account = await ctx.server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: ctx.networkPassphrase })
    .addOperation(Operation.createStellarAssetContract({ asset }))
    .setTimeout(60)
    .build();
  let prepared;
  try {
    prepared = await ctx.server.prepareTransaction(tx);
  } catch (err) {
    const msg = (err as Error).message;
    if (/ExistingValue|already exists|instance already/i.test(msg)) {
      ctx.log(`SAC ${contract} already deployed`);
      return;
    }
    throw err;
  }
  prepared.sign(source);
  const sent = await ctx.server.sendTransaction(prepared);
  if (sent.status !== "PENDING") throw new Error(`SAC deploy rejected: ${sent.status}`);
  const final = await ctx.server.pollTransaction(sent.hash, { attempts: 30 });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`SAC deploy ${final.status}: ${sent.hash}`);
  }
  ctx.log(`SAC ${contract} deployed: ${sent.hash}`);
}

/** Classic balance of `code:issuer` for an account, as a decimal string. */
export async function classicBalance(ctx: TestnetContext, account: string, code: string, issuer: string): Promise<string> {
  const acc = await ctx.horizon.loadAccount(account);
  const bal = acc.balances.find(
    (b) => "asset_code" in b && b.asset_code === code && "asset_issuer" in b && b.asset_issuer === issuer,
  );
  return bal?.balance ?? "0";
}
