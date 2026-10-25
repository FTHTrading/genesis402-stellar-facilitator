/**
 * One-time testnet setup for the G402T test token. TESTNET ONLY.
 *
 *   1. creates an issuer and a distributor (Friendbot)
 *   2. distributor trusts G402T
 *   3. issuer pays the FIXED supply of 1,000,000,000 G402T to the distributor
 *   4. issuer is locked: master weight 0, thresholds 1/1/1, no other signers -> no more can ever be minted
 *   5. a payment from the issuer is attempted and must fail (S5 probe)
 *   6. the Stellar Asset Contract (SAC) is deployed so G402T works in x402 `exact` payments
 *
 * The distributor secret is written only to the secrets env file (created exclusively, never overwritten,
 * never printed). The issuer secret lives only in memory and is dropped after the lock.
 * Public data is written to apps/faucet/testnet-asset.json.
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder, rpc } from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const RPC_URL = "https://soroban-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const CODE = "G402T";
const SUPPLY = "1000000000";
const USDC_TESTNET_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_JSON = join(here, "..", "testnet-asset.json");
const SECRET_FILE = process.env.FAUCET_SECRET_FILE ?? "C:/Users/Kevan/.unykorn/secrets/g402-faucet-testnet.env";

if (PASSPHRASE !== "Test SDF Network ; September 2015") throw new Error("refusing: not the testnet passphrase");

const horizon = new Horizon.Server(HORIZON_URL);
const server = new rpc.Server(RPC_URL);
const log = (line: string) => console.log(line);

async function retry<T>(fn: () => Promise<T>, attempts = 5, baseMs = 1500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, baseMs * (i + 1)));
    }
  }
  throw last;
}

async function friendbot(publicKey: string, label: string): Promise<void> {
  await retry(async () => {
    const res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`);
    if (!res.ok && res.status !== 400) throw new Error(`friendbot HTTP ${res.status} for ${label}`);
  });
  await retry(() => horizon.loadAccount(publicKey));
  log(`funded ${label} ${publicKey}`);
}

function resultCodes(err: unknown): unknown {
  return (err as { response?: { data?: { extras?: { result_codes?: unknown } } } }).response?.data?.extras?.result_codes;
}

async function classic(source: Keypair, ops: Array<ReturnType<typeof Operation.payment>>, label: string): Promise<string> {
  const account = await retry(() => horizon.loadAccount(source.publicKey()));
  const builder = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: PASSPHRASE });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(60).build();
  tx.sign(source);
  try {
    const res = await horizon.submitTransaction(tx);
    log(`${label}: ${res.hash}`);
    return res.hash;
  } catch (err) {
    throw new Error(`${label} failed: ${JSON.stringify(resultCodes(err) ?? (err as Error).message)}`);
  }
}

async function deploySac(source: Keypair, asset: Asset): Promise<{ contract: string; hash: string }> {
  const contract = asset.contractId(PASSPHRASE);
  const account = await retry(() => horizon.loadAccount(source.publicKey()));
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.createStellarAssetContract({ asset }))
    .setTimeout(60)
    .build();
  const prepared = await retry(() => server.prepareTransaction(tx));
  prepared.sign(source);
  const sent = await retry(() => server.sendTransaction(prepared));
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") throw new Error(`SAC deploy rejected: ${sent.status}`);
  const final = await retry(() => server.pollTransaction(sent.hash, { attempts: 30 }));
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`SAC deploy ${final.status}: ${sent.hash}`);
  log(`SAC ${contract} deployed: ${sent.hash}`);
  return { contract, hash: sent.hash };
}

async function main(): Promise<void> {
  if (existsSync(SECRET_FILE)) {
    console.error(`STOP: ${SECRET_FILE} already exists. Not overwriting it. Nothing was created.`);
    process.exit(2);
  }
  if (existsSync(OUT_JSON)) {
    console.error(`STOP: ${OUT_JSON} already exists. G402T is already set up. Nothing was created.`);
    process.exit(2);
  }

  let issuer: Keypair | null = Keypair.random();
  const distributor = Keypair.random();
  const issuerPublic = issuer.publicKey();

  // Persist the distributor secret before anything happens on chain, so a crash cannot strand the supply.
  writeFileSync(
    SECRET_FILE,
    `# Genesis402 faucet distributor, Stellar TESTNET only. Holds test G402T with no value.\n# Distributor public key: ${distributor.publicKey()}\nDISTRIBUTOR_SECRET=${distributor.secret()}\n`,
    { flag: "wx", mode: 0o600 },
  );
  log(`distributor secret written to ${SECRET_FILE} (not printed)`);

  await friendbot(issuerPublic, "issuer");
  await friendbot(distributor.publicKey(), "distributor");

  const asset = new Asset(CODE, issuerPublic);
  const trustHash = await classic(distributor, [Operation.changeTrust({ asset })], "distributor trustline");
  const issueHash = await classic(
    issuer,
    [Operation.payment({ destination: distributor.publicKey(), asset, amount: SUPPLY })],
    `issued ${SUPPLY} ${CODE}`,
  );
  const lockHash = await classic(
    issuer,
    [Operation.setOptions({ masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1 })],
    "issuer locked",
  );

  // S5 probe: the issuer key must no longer be able to authorize anything.
  let probe: string;
  try {
    await classic(
      issuer,
      [Operation.payment({ destination: distributor.publicKey(), asset, amount: "1" })],
      "S5 probe (must fail)",
    );
    throw new Error("S5 FAILED: a payment from the locked issuer succeeded");
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith("S5 FAILED")) throw err;
    probe = msg;
    log(`S5 probe refused as expected: ${msg}`);
  }
  issuer = null; // discard the issuer secret

  const sac = await deploySac(distributor, asset);

  // Verify from Horizon, not from what we sent.
  const issuerAcct = await retry(() => horizon.loadAccount(issuerPublic));
  const master = issuerAcct.signers.find((s) => s.key === issuerPublic);
  const distAcct = await retry(() => horizon.loadAccount(distributor.publicKey()));
  const held = distAcct.balances.find(
    (b) => "asset_code" in b && b.asset_code === CODE && "asset_issuer" in b && b.asset_issuer === issuerPublic,
  );
  const stats = (await (
    await fetch(`${HORIZON_URL}/assets?asset_code=${CODE}&asset_issuer=${issuerPublic}`)
  ).json()) as { _embedded?: { records?: Array<{ balances?: { authorized?: string }; amount?: string }> } };
  const record = stats._embedded?.records?.[0];
  const supplyOnChain = record?.balances?.authorized ?? record?.amount ?? null;

  if (master?.weight !== 0) throw new Error(`issuer master weight is ${master?.weight}, expected 0`);
  if (issuerAcct.signers.some((s) => s.weight > 0)) throw new Error("issuer still has a signer with weight > 0");
  if (held?.balance !== "1000000000.0000000") throw new Error(`distributor holds ${held?.balance}, expected 1000000000.0000000`);

  const out = {
    network: "stellar:testnet",
    networkPassphrase: PASSPHRASE,
    horizonUrl: HORIZON_URL,
    friendbotUrl: FRIENDBOT_URL,
    explorerTxBase: "https://stellar.expert/explorer/testnet/tx/",
    asset: { code: CODE, issuer: issuerPublic, sac: sac.contract },
    distributor: distributor.publicKey(),
    xlmSac: Asset.native().contractId(PASSPHRASE),
    usdc: { sac: USDC_TESTNET_SAC, faucetUrl: "https://faucet.circle.com" },
    supply: SUPPLY,
    setup: {
      createdAt: new Date().toISOString(),
      txs: { distributorTrustline: trustHash, issue: issueHash, lockIssuer: lockHash, deploySac: sac.hash },
      issuerLock: {
        masterWeight: master.weight,
        thresholds: issuerAcct.thresholds,
        signers: issuerAcct.signers,
      },
      distributorBalance: held.balance,
      horizonAssetSupply: supplyOnChain,
      s5ProbeRefused: probe,
    },
  };
  writeFileSync(OUT_JSON, `${JSON.stringify(out, null, 2)}\n`, { flag: "wx" });
  log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(`setup failed: ${(err as Error).message}`);
  process.exit(1);
});
