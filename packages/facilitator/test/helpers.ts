import { Keypair, Networks } from "@stellar/stellar-sdk";
import { buildPaymentTransactionOffline } from "../src/client.js";
import type { PaymentPayload, PaymentRequirements } from "../src/types.js";

export const TESTNET = "stellar:testnet";
export const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const OTHER_ASSET = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

export const payer = Keypair.random();
export const seller = Keypair.random();
export const facilitator = Keypair.random();
export const CURRENT_LEDGER = 1_000_000;

export function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: TESTNET,
    asset: USDC_TESTNET,
    amount: "100000",
    payTo: seller.publicKey(),
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
    ...overrides,
  };
}

export interface BuildOpts {
  payerKp?: Keypair;
  signerKp?: Keypair | null;
  payTo?: string;
  asset?: string;
  amount?: string;
  validUntilLedgerSeq?: number;
  sourceAccount?: string;
}

export async function signedPayload(
  req: PaymentRequirements,
  opts: BuildOpts = {},
): Promise<PaymentPayload> {
  const kp = opts.payerKp ?? payer;
  const xdr = await buildPaymentTransactionOffline({
    payer: kp.publicKey(),
    signer: opts.signerKp === undefined ? kp : opts.signerKp,
    payTo: opts.payTo ?? req.payTo,
    asset: opts.asset ?? req.asset,
    amount: opts.amount ?? req.amount,
    validUntilLedgerSeq: opts.validUntilLedgerSeq ?? CURRENT_LEDGER + 10,
    networkPassphrase: Networks.TESTNET,
    ...(opts.sourceAccount ? { sourceAccount: opts.sourceAccount } : {}),
  });
  return {
    x402Version: 2,
    resource: {
      url: "https://seller.example/weather",
      description: "test",
      mimeType: "application/json",
    },
    accepted: req,
    payload: { transaction: xdr },
  };
}
