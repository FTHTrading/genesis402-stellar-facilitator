import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  authorizeInvocation,
  nativeToScVal,
  xdr,
  type rpc,
} from "@stellar/stellar-sdk";
import {
  DEFAULT_ESTIMATED_LEDGER_SECONDS,
  SCHEME_EXACT,
  STELLAR_CONTRACT_REGEX,
  STELLAR_DESTINATION_REGEX,
  SUPPORTED_X402_VERSION,
  isStellarNetwork,
  passphraseFor,
} from "./constants.js";
import { withRetry } from "./retry.js";
import type { PaymentPayload, PaymentRequirements, ResourceInfo } from "./types.js";

/** Anything that can produce an Ed25519 signature for the payer (a Keypair, or a remote signer). */
export type PayerSigner = Keypair | ((payload: Uint8Array) => Promise<Uint8Array>);

export interface BuildPaymentOffline {
  /** G... address whose funds are transferred and whose auth entry is signed. */
  payer: string;
  /** Signer for the payer. `null` produces an unsigned transaction (used in tests). */
  signer: PayerSigner | null;
  payTo: string;
  /** Token contract (C...) implementing SEP-41 `transfer`. */
  asset: string;
  /** Atomic amount (7 decimals for USDC). */
  amount: string;
  /** Exclusive ledger sequence until which the signature is valid. */
  validUntilLedgerSeq: number;
  networkPassphrase: string;
  /** Transaction source account; defaults to the payer. Never the facilitator. */
  sourceAccount?: string;
  /** Sequence number for the source account; irrelevant because the facilitator rebuilds the tx. */
  sequence?: string;
}

/** Builds the SEP-41 `transfer(from, to, amount)` invocation as XDR. */
export function transferInvocation(payer: string, payTo: string, asset: string, amount: string) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(asset).toScAddress(),
        functionName: "transfer",
        args: transferArgs(payer, payTo, amount),
      }),
    ),
    subInvocations: [],
  });
}

export function transferArgs(payer: string, payTo: string, amount: string): xdr.ScVal[] {
  return [
    new Address(payer).toScVal(),
    new Address(payTo).toScVal(),
    nativeToScVal(BigInt(amount), { type: "i128" }),
  ];
}

/**
 * Builds the base64 transaction XDR that the x402 Stellar `exact` payload
 * carries, without any network access: one `invokeHostFunction` operation that
 * calls `transfer(from, to, amount)` with a signed authorization entry for the
 * payer. The facilitator discards everything except the operation and the auth
 * entries, so the source account and sequence here do not matter.
 */
export async function buildPaymentTransactionOffline(opts: BuildPaymentOffline): Promise<string> {
  const invocation = transferInvocation(opts.payer, opts.payTo, opts.asset, opts.amount);
  const auth: xdr.SorobanAuthorizationEntry[] = [];
  if (opts.signer) {
    const signer = opts.signer;
    auth.push(
      await authorizeInvocation({
        signer:
          signer instanceof Keypair
            ? signer
            : async (_preimage, payload) => ({
                signature: await signer(payload),
                publicKey: opts.payer,
              }),
        publicKey: opts.payer,
        validUntilLedgerSeq: opts.validUntilLedgerSeq,
        invocation,
        networkPassphrase: opts.networkPassphrase,
      }),
    );
  }
  const source = new Account(opts.sourceAccount ?? opts.payer, opts.sequence ?? "0");
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: opts.networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: opts.asset,
        function: "transfer",
        args: transferArgs(opts.payer, opts.payTo, opts.amount),
        auth,
      }),
    )
    .setTimeout(300)
    .build();
  return tx.toXDR();
}

export interface CreatePaymentOptions {
  payer: string;
  signer: PayerSigner;
  requirements: PaymentRequirements;
  rpc: Pick<rpc.Server, "getLatestLedger">;
  resource?: ResourceInfo;
  estimatedLedgerSeconds?: number;
}

/**
 * Creates a full x402 v2 PaymentPayload for a Stellar `exact` requirement.
 * The signature expiry is `currentLedger + ceil(maxTimeoutSeconds / ledgerSeconds)`.
 */
export async function createPaymentPayload(opts: CreatePaymentOptions): Promise<PaymentPayload> {
  const req = opts.requirements;
  if (req.scheme !== SCHEME_EXACT) throw new Error(`Unsupported scheme: ${req.scheme}`);
  if (!isStellarNetwork(req.network)) throw new Error(`Unsupported network: ${req.network}`);
  if (!STELLAR_DESTINATION_REGEX.test(req.payTo)) throw new Error(`Invalid payTo: ${req.payTo}`);
  if (!STELLAR_CONTRACT_REGEX.test(req.asset)) throw new Error(`Invalid asset contract: ${req.asset}`);
  if (!/^\d+$/.test(req.amount) || BigInt(req.amount) <= 0n) {
    throw new Error(`Invalid amount: ${req.amount}`);
  }
  if (req.extra?.["areFeesSponsored"] !== true) {
    throw new Error("Stellar exact scheme requires extra.areFeesSponsored === true");
  }
  const latest = await withRetry(() => opts.rpc.getLatestLedger());
  const ledgerSeconds = opts.estimatedLedgerSeconds ?? DEFAULT_ESTIMATED_LEDGER_SECONDS;
  const validUntilLedgerSeq = latest.sequence + Math.ceil(req.maxTimeoutSeconds / ledgerSeconds);
  const transaction = await buildPaymentTransactionOffline({
    payer: opts.payer,
    signer: opts.signer,
    payTo: req.payTo,
    asset: req.asset,
    amount: req.amount,
    validUntilLedgerSeq,
    networkPassphrase: passphraseFor(req.network),
  });
  return {
    x402Version: SUPPORTED_X402_VERSION,
    ...(opts.resource ? { resource: opts.resource } : {}),
    accepted: req,
    payload: { transaction },
  };
}

/** Encodes a PaymentPayload for the PAYMENT-SIGNATURE header. */
export function encodePaymentHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/** Decodes a PAYMENT-REQUIRED header (base64 JSON). */
export function decodeBase64Json<T = unknown>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}
