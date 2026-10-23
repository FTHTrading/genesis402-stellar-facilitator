import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeInvocation,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { withRetry } from "@genesis402/stellar-facilitator";
import {
  classicBalance,
  ensureFunded,
  issueDemoAsset,
  type TestnetContext,
} from "../../../examples/payer/src/testnet.js";

const enabled = process.env["T2_TESTNET"] === "1";
const here = dirname(fileURLToPath(import.meta.url));
const keysPath = join(here, "deploy-keys.json"); // gitignored (contracts/.gitignore: deploy-keys*.json)

interface Keys {
  deployer: string;
  payer: string;
  seller: string;
  facilitator: string;
  issuer: string;
}

function loadOrCreateKeys(): Record<keyof Keys, Keypair> {
  let stored: Partial<Keys> = {};
  if (existsSync(keysPath)) stored = JSON.parse(readFileSync(keysPath, "utf8")) as Partial<Keys>;
  const pick = (k: keyof Keys) => (stored[k] ? Keypair.fromSecret(stored[k]!) : Keypair.random());
  const keys = {
    deployer: pick("deployer"),
    payer: pick("payer"),
    seller: pick("seller"),
    facilitator: pick("facilitator"),
    issuer: pick("issuer"),
  };
  writeFileSync(
    keysPath,
    JSON.stringify(Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.secret()])), null, 2),
  );
  return keys;
}

function wasmPath(): string {
  const candidates = [
    process.env["X402_SETTLE_WASM"],
    process.env["CARGO_TARGET_DIR"] && join(process.env["CARGO_TARGET_DIR"], "wasm32v1-none/release/x402_settle.wasm"),
    resolve(here, "../target/wasm32v1-none/release/x402_settle.wasm"),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`x402_settle.wasm not found; run 'stellar contract build' in contracts/x402-settle (looked in ${candidates.join(", ")})`);
  return found;
}

/** Simulate, sign with `signers`, send, and poll to SUCCESS. Returns the final RPC record. */
async function submitSoroban(
  ctx: TestnetContext,
  tx: Transaction,
  signers: Keypair[],
  label: string,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const prepared = await withRetry(() => ctx.server.prepareTransaction(tx));
  for (const s of signers) prepared.sign(s);
  const sent = await withRetry(() => ctx.server.sendTransaction(prepared));
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new Error(`${label}: sendTransaction ${sent.status} ${sent.errorResult?.toXDR("base64") ?? ""}`);
  }
  const final = await withRetry(() => ctx.server.pollTransaction(sent.hash, { attempts: 40 }));
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${label}: ${final.status} ${sent.hash}`);
  }
  ctx.log(`${label}: ${sent.hash}`);
  return final;
}

async function deployContract(ctx: TestnetContext, deployer: Keypair): Promise<{ contractId: string; wasmHash: string; uploadTx: string; deployTx: string }> {
  const wasm = readFileSync(wasmPath());
  const acct1 = await withRetry(() => ctx.horizon.loadAccount(deployer.publicKey()));
  const upload = new TransactionBuilder(acct1, { fee: BASE_FEE, networkPassphrase: ctx.networkPassphrase })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(120)
    .build();
  const up = await submitSoroban(ctx, upload, [deployer], "upload wasm");
  const wasmHash = Buffer.from((scValToNative(up.returnValue!) as Uint8Array)).toString("hex");

  const acct2 = await withRetry(() => ctx.horizon.loadAccount(deployer.publicKey()));
  const create = new TransactionBuilder(acct2, { fee: BASE_FEE, networkPassphrase: ctx.networkPassphrase })
    .addOperation(
      Operation.createCustomContract({
        address: new Address(deployer.publicKey()),
        wasmHash: Buffer.from(wasmHash, "hex"),
        salt: randomBytes(32),
      }),
    )
    .setTimeout(120)
    .build();
  const made = await submitSoroban(ctx, create, [deployer], "create contract");
  const contractId = Address.fromScVal(made.returnValue!).toString();
  return { contractId, wasmHash, uploadTx: up.txHash, deployTx: made.txHash };
}

interface Quote {
  payer: string;
  seller: string;
  token: string;
  amount: bigint;
  nonce: Buffer;
  expiryLedger: number;
}

function settleArgs(q: Quote): xdr.ScVal[] {
  return [
    new Address(q.payer).toScVal(),
    new Address(q.seller).toScVal(),
    new Address(q.token).toScVal(),
    nativeToScVal(q.amount, { type: "i128" }),
    xdr.ScVal.scvBytes(q.nonce),
    nativeToScVal(q.expiryLedger, { type: "u32" }),
  ];
}

/**
 * Builds the settle transaction the way the facilitator would: facilitator is
 * the fee-paying source, the payer signs only the Soroban authorization entry
 * for `settle(...)` (whose sub-invocation is the token transfer).
 */
async function buildSettle(
  ctx: TestnetContext,
  contractId: string,
  q: Quote,
  payer: Keypair,
  facilitator: Keypair,
): Promise<{ tx: Transaction; sim: rpc.Api.SimulateTransactionResponse }> {
  const source = await withRetry(() => ctx.horizon.loadAccount(facilitator.publicKey()));
  const unsigned = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: ctx.networkPassphrase })
    .addOperation(Operation.invokeContractFunction({ contract: contractId, function: "settle", args: settleArgs(q) }))
    .setTimeout(120)
    .build();
  const sim = await withRetry(() => ctx.server.simulateTransaction(unsigned));
  if (rpc.Api.isSimulationError(sim)) return { tx: unsigned, sim };
  const latest = await withRetry(() => ctx.server.getLatestLedger());
  const validUntil = latest.sequence + 60;
  const auth: xdr.SorobanAuthorizationEntry[] = [];
  for (const entry of sim.result?.auth ?? []) {
    // stellar-sdk 17 typed XDR: `credentials` is a tagged value. Simulation may return the
    // legacy address form or (with upgraded auth) the CAP-71 V2 form; both name the payer.
    const creds = entry.credentials as unknown as {
      type: string;
      address?: { address: xdr.ScAddress };
      addressV2?: { address: xdr.ScAddress };
    };
    const addr = creds.address?.address ?? creds.addressV2?.address;
    if (creds.type !== "sorobanCredentialsSourceAccount" && addr) {
      const who = Address.fromScAddress(addr).toString();
      if (who !== payer.publicKey()) throw new Error(`unexpected authorizer ${who}`);
      // Build the payer's entry from the simulated invocation tree (settle + its token sub-invocation)
      // with CAP-71 V2 credentials, the same path the T1 facilitator client uses on testnet.
      auth.push(
        await authorizeInvocation({
          signer: payer,
          publicKey: payer.publicKey(),
          validUntilLedgerSeq: validUntil,
          invocation: entry.rootInvocation,
          networkPassphrase: ctx.networkPassphrase,
        }),
      );
    } else {
      auth.push(entry);
    }
  }
  expect(auth.length).toBe(1); // exactly one payer entry; the facilitator authorizes nothing
  const signedSource = await withRetry(() => ctx.horizon.loadAccount(facilitator.publicKey()));
  const tx = new TransactionBuilder(signedSource, { fee: BASE_FEE, networkPassphrase: ctx.networkPassphrase })
    .addOperation(Operation.invokeContractFunction({ contract: contractId, function: "settle", args: settleArgs(q), auth }))
    .setTimeout(120)
    .build();
  return { tx, sim };
}

async function readIsSettled(ctx: TestnetContext, contractId: string, payer: string, nonce: Buffer, reader: Keypair): Promise<boolean> {
  const source = await withRetry(() => ctx.horizon.loadAccount(reader.publicKey()));
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: ctx.networkPassphrase })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: "is_settled",
        args: [new Address(payer).toScVal(), xdr.ScVal.scvBytes(nonce)],
      }),
    )
    .setTimeout(60)
    .build();
  const sim = await withRetry(() => ctx.server.simulateTransaction(tx));
  if (rpc.Api.isSimulationError(sim)) throw new Error(`is_settled simulation failed: ${sim.error}`);
  return scValToNative(sim.result!.retval) as boolean;
}

/**
 * Real Stellar testnet run of the x402-settle contract. Opt in with T2_TESTNET=1.
 * Deploys a fresh instance from the locally built wasm (or reuses
 * X402_SETTLE_CONTRACT_ID), pays with the DEMO asset TUSDC issued per run,
 * settles once, reads is_settled, and proves that a second
 * payer-signed attempt on the same quote nonce is refused by the contract on chain.
 */
describe.skipIf(!enabled)("x402-settle on Stellar testnet", () => {
  it("deploys, settles once, reads is_settled, refuses the replay on chain", async () => {
    // T2_TRANSCRIPT=<path> also appends every line to a file (vitest hides console output of passing tests).
    const transcript = process.env["T2_TRANSCRIPT"];
    const log = (line: string) => {
      console.log(line);
      if (transcript) appendFileSync(transcript, `${line}\n`);
    };
    const rpcUrl = process.env["STELLAR_RPC_URL"] ?? "https://soroban-testnet.stellar.org";
    const ctx: TestnetContext = {
      server: new rpc.Server(rpcUrl),
      horizon: new Horizon.Server(process.env["STELLAR_HORIZON_URL"] ?? "https://horizon-testnet.stellar.org"),
      networkPassphrase: Networks.TESTNET,
      log,
    };
    const k = loadOrCreateKeys();
    log(`deployer    ${k.deployer.publicKey()}`);
    log(`payer       ${k.payer.publicKey()}`);
    log(`seller      ${k.seller.publicKey()}`);
    log(`facilitator ${k.facilitator.publicKey()}`);
    log(`issuer      ${k.issuer.publicKey()}`);
    for (const [label, kp] of Object.entries(k)) await ensureFunded(ctx, kp.publicKey(), label);

    // DEMO asset: TUSDC issued per run. The facilitator holds no trustline: it receives nothing.
    const asset = await issueDemoAsset(ctx, k.issuer, k.payer, k.seller, "100");
    log(`asset ${asset.code} ${asset.contract} [${asset.label}]`);

    // Deploy (or reuse).
    let contractId = process.env["X402_SETTLE_CONTRACT_ID"];
    if (!contractId) {
      const d = await deployContract(ctx, k.deployer);
      contractId = d.contractId;
      log(`wasm hash   ${d.wasmHash}`);
      log(`upload tx   https://stellar.expert/explorer/testnet/tx/${d.uploadTx}`);
      log(`deploy tx   https://stellar.expert/explorer/testnet/tx/${d.deployTx}`);
    }
    log(`contract    ${contractId}`);
    log(`explorer    https://stellar.expert/explorer/testnet/contract/${contractId}`);

    const latest = await withRetry(() => ctx.server.getLatestLedger());
    const quote: Quote = {
      payer: k.payer.publicKey(),
      seller: k.seller.publicKey(),
      token: asset.contract,
      amount: 1_000_000n, // 0.1 TUSDC
      nonce: randomBytes(32),
      expiryLedger: latest.sequence + 120,
    };
    expect(await readIsSettled(ctx, contractId, quote.payer, quote.nonce, k.facilitator)).toBe(false);

    const before = {
      payer: await classicBalance(ctx, quote.payer, asset.code, asset.issuer),
      seller: await classicBalance(ctx, quote.seller, asset.code, asset.issuer),
    };

    // 1. Settle once.
    const first = await buildSettle(ctx, contractId, quote, k.payer, k.facilitator);
    expect(rpc.Api.isSimulationError(first.sim)).toBe(false);
    const settled = await submitSoroban(ctx, first.tx, [k.facilitator], "settle");
    log(`settle tx   https://stellar.expert/explorer/testnet/tx/${settled.txHash}`);
    expect(settled.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);

    // 2. is_settled reads true.
    expect(await readIsSettled(ctx, contractId, quote.payer, quote.nonce, k.facilitator)).toBe(true);

    // 3. Balances: payer -amount, seller +amount, exactly (7 decimals). No fee anywhere.
    const after = {
      payer: await classicBalance(ctx, quote.payer, asset.code, asset.issuer),
      seller: await classicBalance(ctx, quote.seller, asset.code, asset.issuer),
    };
    const stroops = (s: string) => BigInt(Math.round(Number(s) * 1e7));
    expect(stroops(before.payer) - stroops(after.payer)).toBe(quote.amount);
    expect(stroops(after.seller) - stroops(before.seller)).toBe(quote.amount);
    log(`balances    payer ${before.payer} -> ${after.payer}; seller ${before.seller} -> ${after.seller}`);

    // 4. Replay: the payer signs the same quote again (fresh auth signature, same contract nonce).
    //    The contract refuses with Error #1 AlreadySettled against live ledger state; nothing moves.
    const replay = await buildSettle(ctx, contractId, quote, k.payer, k.facilitator);
    expect(rpc.Api.isSimulationError(replay.sim)).toBe(true);
    const err = (replay.sim as rpc.Api.SimulateTransactionErrorResponse).error;
    log(`replay      refused by contract: ${err.match(/Error\(Contract, #\d+\)/)?.[0] ?? err.slice(0, 160)}`);
    expect(err).toMatch(/Error\(Contract, #1\)/);
    expect(await classicBalance(ctx, quote.seller, asset.code, asset.issuer)).toBe(after.seller);

    // 5. Re-sending the already-applied envelope is also refused by the network (sequence consumed).
    const resend = await ctx.server.sendTransaction(first.tx as Transaction).catch((e: Error) => ({ status: `threw ${e.message}` }));
    expect(resend.status).not.toBe("PENDING");
    log(`resend      ${resend.status}`);

    log("");
    log("T2 RESULT");
    log(`  contract     ${contractId}`);
    log(`  settle tx    ${settled.txHash}`);
    log(`  asset        ${asset.code} ${asset.contract} [${asset.label}]`);
    log(`  amount       ${quote.amount} stroops of TUSDC, payer -> seller, no fee`);
    log(`  is_settled   true`);
    log(`  replay       refused (Error(Contract, #1) AlreadySettled)`);
  }, 600_000);
});
