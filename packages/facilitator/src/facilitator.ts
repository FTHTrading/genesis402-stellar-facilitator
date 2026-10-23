import {
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  type Account,
} from "@stellar/stellar-sdk";
import type { ChainClient, TransferEvent } from "./chain.js";
import {
  DEFAULT_INCLUSION_FEE_STROOPS,
  DEFAULT_MAX_TRANSACTION_FEE_STROOPS,
  DEFAULT_TIMEOUT_SECONDS,
  SCHEME_EXACT,
  SUPPORTED_X402_VERSION,
  isStellarNetwork,
  passphraseFor,
} from "./constants.js";
import type { NonceStore } from "./nonce-store.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "./types.js";
import { verifyStatic, type StaticResult } from "./verify.js";

export interface FacilitatorOptions {
  /** CAIP-2 network this instance settles on, e.g. `stellar:testnet`. */
  network: string;
  /** Settlement signer. It pays fees and spends its sequence number; it never holds buyer funds. */
  signer: Keypair;
  chain: ChainClient;
  nonceStore: NonceStore;
  /** Safety ceiling for the simulation-derived fee (stroops). Default 50,000. */
  maxTransactionFeeStroops?: number;
  /** Inclusion fee bid on top of the resource fee (stroops). Default 100. */
  inclusionFeeStroops?: number;
}

type Prepared = Extract<StaticResult, { ok: true }> & {
  rebuilt: Transaction;
  assemble: (tx: Transaction) => Transaction;
};

type PrepareResult = { ok: true; prepared: Prepared } | { ok: false; response: VerifyResponse };

/**
 * x402 `exact` facilitator for Stellar. Buyers sign a Soroban authorization
 * entry for one SEP-41 `transfer`; this service checks it, re-simulates it with
 * its own account as transaction source, sponsors the fee, submits, and waits
 * for inclusion. Non-custodial: funds move payer -> seller inside the token
 * contract; the facilitator is never `from`, `to`, or an auth signer.
 */
export class StellarFacilitator {
  readonly network: string;
  readonly networkPassphrase: string;
  readonly signer: Keypair;
  readonly address: string;
  readonly maxTransactionFeeStroops: number;
  readonly inclusionFeeStroops: number;
  private readonly chain: ChainClient;
  private readonly nonces: NonceStore;
  private readonly facilitatorAddresses: ReadonlySet<string>;

  constructor(opts: FacilitatorOptions) {
    if (!isStellarNetwork(opts.network)) throw new Error(`Unsupported network ${opts.network}`);
    this.network = opts.network;
    this.networkPassphrase = passphraseFor(opts.network);
    this.signer = opts.signer;
    this.address = opts.signer.publicKey();
    this.chain = opts.chain;
    this.nonces = opts.nonceStore;
    this.maxTransactionFeeStroops =
      opts.maxTransactionFeeStroops ?? DEFAULT_MAX_TRANSACTION_FEE_STROOPS;
    this.inclusionFeeStroops = opts.inclusionFeeStroops ?? DEFAULT_INCLUSION_FEE_STROOPS;
    this.facilitatorAddresses = new Set([this.address]);
  }

  supported(): SupportedResponse {
    return {
      kinds: [
        {
          x402Version: SUPPORTED_X402_VERSION,
          scheme: SCHEME_EXACT,
          network: this.network,
          extra: { areFeesSponsored: true },
        },
      ],
      extensions: [],
      signers: { "stellar:*": [this.address] },
    };
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const r = await this.prepare(payload, requirements);
    return r.ok ? { isValid: true, payer: r.prepared.payer } : r.response;
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = payload.accepted?.network ?? requirements.network;
    const r = await this.prepare(payload, requirements);
    if (!r.ok) {
      return {
        success: false,
        errorReason: r.response.invalidReason ?? "verification_failed",
        ...(r.response.invalidMessage ? { errorMessage: r.response.invalidMessage } : {}),
        transaction: "",
        network,
        ...(r.response.payer ? { payer: r.response.payer } : {}),
      };
    }
    const p = r.prepared;
    const failed = (errorReason: string, transaction = "", errorMessage?: string): SettleResponse => ({
      success: false,
      errorReason,
      ...(errorMessage ? { errorMessage } : {}),
      transaction,
      network,
      payer: p.payer,
    });

    let txHash = "";
    try {
      const tx = p.assemble(p.rebuilt);
      tx.sign(this.signer);
      txHash = Buffer.from(tx.hash()).toString("hex");

      // Claim the nonce right before submission; a concurrent settle of the same
      // payload loses this race and is refused.
      if (!this.nonces.consume(this.network, p.payer, p.nonce, txHash)) {
        return failed("invalid_exact_stellar_payload_nonce_reused");
      }

      const sent = await this.chain.send(tx);
      if (sent.status !== "PENDING") {
        if (sent.status === "ERROR") this.nonces.release(this.network, p.payer, p.nonce);
        return failed("settle_exact_stellar_transaction_submission_failed", "", sent.error);
      }
      txHash = sent.hash;

      const final = await this.chain.waitForTransaction(
        txHash,
        requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      );
      if (final.status !== "SUCCESS") {
        return failed(
          final.status === "FAILED"
            ? "settle_exact_stellar_transaction_failed"
            : "settle_exact_stellar_transaction_not_confirmed",
          txHash,
        );
      }
      return {
        success: true,
        transaction: txHash,
        network,
        payer: p.payer,
        amount: requirements.amount,
      };
    } catch (err) {
      return failed("unexpected_settle_error", txHash, (err as Error).message);
    }
  }

  /** Static checks, then rebuild with this facilitator as source, simulate, and inspect balance changes. */
  private async prepare(payload: PaymentPayload, requirements: PaymentRequirements): Promise<PrepareResult> {
    const invalid = (invalidReason: string, payer?: string, invalidMessage?: string): PrepareResult => ({
      ok: false,
      response: {
        isValid: false,
        invalidReason,
        ...(payer ? { payer } : {}),
        ...(invalidMessage ? { invalidMessage } : {}),
      },
    });

    if (requirements.network !== this.network) return invalid("invalid_network");

    let currentLedger: number;
    let estimatedLedgerSeconds: number;
    try {
      [currentLedger, estimatedLedgerSeconds] = await Promise.all([
        this.chain.getLatestLedger(),
        this.chain.estimatedLedgerSeconds(),
      ]);
    } catch (err) {
      return invalid("unexpected_verify_error", undefined, (err as Error).message);
    }

    const s = verifyStatic(payload, requirements, {
      networkPassphrase: this.networkPassphrase,
      facilitatorAddresses: this.facilitatorAddresses,
      currentLedger,
      estimatedLedgerSeconds,
      nonceStore: this.nonces,
    });
    if (!s.ok) return invalid(s.reason, s.payer, s.message);

    let account: Account;
    try {
      account = await this.chain.getAccount(this.address);
    } catch (err) {
      return invalid("unexpected_verify_error", s.payer, (err as Error).message);
    }

    // Rebuild: facilitator is the source and fee payer; operation and auth entries are the buyer's.
    const rebuilt = new TransactionBuilder(account, {
      fee: String(this.inclusionFeeStroops),
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({ func: s.invokeOp.func, auth: s.invokeOp.auth ?? [] }),
      )
      .setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
      .build();

    const expected: TransferEvent = {
      asset: requirements.asset,
      from: s.payer,
      to: requirements.payTo,
      amount: BigInt(requirements.amount),
    };
    const sim = await this.chain.simulate(rebuilt, expected);
    if (!sim.ok) return invalid("invalid_exact_stellar_payload_simulation_failed", s.payer, sim.error);

    const settlementFee = Number.parseInt(sim.minResourceFee, 10) + this.inclusionFeeStroops;
    if (settlementFee > this.maxTransactionFeeStroops) {
      return invalid(
        "invalid_exact_stellar_payload_fee_exceeds_maximum",
        s.payer,
        `simulation-derived fee ${settlementFee} stroops exceeds ceiling ${this.maxTransactionFeeStroops}`,
      );
    }

    const eventError = checkTransfers(sim.transfers, expected);
    if (eventError) return invalid(eventError, s.payer);

    return { ok: true, prepared: { ...s, rebuilt, assemble: sim.assemble } };
  }
}

/** The simulation must show exactly one balance change: payer -> payTo, exact amount, on the required asset. */
export function checkTransfers(transfers: TransferEvent[], expected: TransferEvent): string | undefined {
  if (transfers.length === 0) return "invalid_exact_stellar_payload_no_transfer_events";
  if (transfers.length > 1) return "invalid_exact_stellar_payload_multiple_transfers";
  const t = transfers[0]!;
  if (t.asset !== expected.asset) return "invalid_exact_stellar_payload_event_wrong_asset";
  if (t.from !== expected.from) return "invalid_exact_stellar_payload_event_wrong_from";
  if (t.to !== expected.to) return "invalid_exact_stellar_payload_event_wrong_to";
  if (t.amount !== expected.amount) return "invalid_exact_stellar_payload_event_wrong_amount";
  return undefined;
}
