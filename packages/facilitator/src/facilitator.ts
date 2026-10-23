import { Keypair, Operation, Transaction, TransactionBuilder, type Account } from "@stellar/stellar-sdk";
import type { ChainClient, TransferEvent } from "./chain.js";
import {
  DEFAULT_INCLUSION_FEE_STROOPS,
  DEFAULT_MAX_TRANSACTION_FEE_STROOPS,
  DEFAULT_TIMEOUT_SECONDS,
  SCHEME_EXACT,
  SUPPORTED_X402_VERSION,
  USDC_SAC,
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
  /**
   * Token contracts this facilitator will sponsor. Default: Circle USDC on the
   * network. Anything else is refused at verify (`asset_not_allowed`).
   */
  allowedAssets?: readonly string[];
  /** Safety ceiling for the simulation-derived fee (stroops). Default 50,000. */
  maxTransactionFeeStroops?: number;
  /** Inclusion fee bid on top of the resource fee (stroops). Default 100. */
  inclusionFeeStroops?: number;
  /** Server-side logger for causes that are never sent to clients. */
  log?: (message: string, err?: unknown) => void;
}

type Static = Extract<StaticResult, { ok: true }>;
type Invalid = { ok: false; reason: string; payer?: string; nonce?: string };
type Prepared = { ok: true; rebuilt: Transaction; assemble: (tx: Transaction) => Transaction };

/** Promise-chain mutex: one settlement at a time per facilitator account. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * x402 `exact` facilitator for Stellar. Buyers sign a Soroban authorization
 * entry for one SEP-41 `transfer`; this service checks it, re-simulates it with
 * its own account as transaction source, sponsors the fee, submits, and waits
 * for inclusion. Non-custodial: funds move payer -> seller inside the token
 * contract; the facilitator is never `from`, `to`, or an auth signer.
 *
 * Settlements are serialized per facilitator account (one Stellar account has
 * one sequence number; a second envelope at the same sequence is not admitted).
 * Throughput is therefore one settlement per ledger per signer; channel
 * accounts are the T2 answer.
 */
export class StellarFacilitator {
  readonly network: string;
  readonly networkPassphrase: string;
  readonly signer: Keypair;
  readonly address: string;
  readonly allowedAssets: ReadonlySet<string>;
  readonly maxTransactionFeeStroops: number;
  readonly inclusionFeeStroops: number;
  private readonly chain: ChainClient;
  private readonly nonces: NonceStore;
  private readonly facilitatorAddresses: ReadonlySet<string>;
  private readonly lock = new Mutex();
  private readonly log: (message: string, err?: unknown) => void;

  constructor(opts: FacilitatorOptions) {
    if (!isStellarNetwork(opts.network)) throw new Error(`Unsupported network ${opts.network}`);
    this.network = opts.network;
    this.networkPassphrase = passphraseFor(opts.network);
    this.signer = opts.signer;
    this.address = opts.signer.publicKey();
    this.chain = opts.chain;
    this.nonces = opts.nonceStore;
    const defaults = USDC_SAC[opts.network];
    const allowed = opts.allowedAssets ?? (defaults ? [defaults] : []);
    if (allowed.length === 0) throw new Error("allowedAssets must name at least one token contract");
    this.allowedAssets = new Set(allowed);
    this.maxTransactionFeeStroops = opts.maxTransactionFeeStroops ?? DEFAULT_MAX_TRANSACTION_FEE_STROOPS;
    this.inclusionFeeStroops = opts.inclusionFeeStroops ?? DEFAULT_INCLUSION_FEE_STROOPS;
    this.facilitatorAddresses = new Set([this.address]);
    this.log = opts.log ?? ((m, e) => console.error(`[facilitator] ${m}`, e ?? ""));
  }

  supported(): SupportedResponse {
    return {
      kinds: [
        {
          x402Version: SUPPORTED_X402_VERSION,
          scheme: SCHEME_EXACT,
          network: this.network,
          extra: { areFeesSponsored: true, assets: [...this.allowedAssets] },
        },
      ],
      extensions: [],
      signers: { "stellar:*": [this.address] },
    };
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const s = await this.check(payload, requirements);
    if (!s.ok) return invalid(s);
    const p = await this.prepare(s, requirements);
    if (!p.ok) return invalid(p);
    return { isValid: true, payer: s.payer };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = payload.accepted?.network ?? requirements.network;
    const failed = (errorReason: string, payer?: string, transaction = ""): SettleResponse => ({
      success: false,
      errorReason,
      transaction,
      network,
      ...(payer ? { payer } : {}),
    });

    const s = await this.check(payload, requirements);
    if (!s.ok) {
      // A replay names the transaction that consumed the entry so the seller can confirm it on chain.
      let recorded = "";
      if (s.reason === "invalid_exact_stellar_payload_nonce_reused" && s.payer && s.nonce) {
        try {
          recorded = this.nonces.lookup(this.network, s.payer, s.nonce) ?? "";
        } catch {
          recorded = "";
        }
      }
      return failed(s.reason, s.payer, recorded);
    }

    return this.lock.run(async () => {
      const p = await this.prepare(s, requirements);
      if (!p.ok) return failed(p.reason, s.payer);

      let tx: Transaction;
      let hash: string;
      try {
        tx = p.assemble(p.rebuilt);
        tx.sign(this.signer);
        hash = Buffer.from(tx.hash()).toString("hex");
      } catch (err) {
        this.log(`assemble/sign failed for ${s.payer}`, err);
        return failed("unexpected_settle_error", s.payer);
      }

      // Claim the nonce right before submission; a concurrent settle of the same payload loses this race.
      let claimed: boolean;
      try {
        claimed = this.nonces.consume(this.network, s.payer, s.nonce, hash);
      } catch (err) {
        this.log("nonce store unavailable at claim", err);
        return failed("nonce_store_unavailable", s.payer);
      }
      if (!claimed) return failed("invalid_exact_stellar_payload_nonce_reused", s.payer, this.safeLookup(s));

      let sent: { status: string; hash: string; error?: string };
      try {
        sent = await this.chain.send(tx);
      } catch (err) {
        // Ambiguous: the envelope may have reached a node. Keep the claim; report the hash for reconciliation.
        this.log(`sendTransaction threw for ${hash}`, err);
        return failed("unexpected_settle_error", s.payer, hash);
      }
      if (sent.status !== "PENDING") {
        // ERROR and TRY_AGAIN_LATER mean the network did not admit this envelope: the entry is unspent.
        if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
          this.safeRelease(s);
        }
        this.log(`sendTransaction ${sent.status} for ${hash}: ${sent.error ?? ""}`);
        return failed("settle_exact_stellar_transaction_submission_failed", s.payer);
      }
      hash = sent.hash;

      let final: { status: string };
      try {
        final = await this.chain.waitForTransaction(hash, requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
      } catch (err) {
        this.log(`confirmation poll failed for ${hash}`, err);
        return failed("settle_exact_stellar_transaction_not_confirmed", s.payer, hash);
      }
      if (final.status === "SUCCESS") {
        return { success: true, transaction: hash, network, payer: s.payer, amount: requirements.amount };
      }
      return failed(
        final.status === "FAILED"
          ? "settle_exact_stellar_transaction_failed"
          : "settle_exact_stellar_transaction_not_confirmed",
        s.payer,
        hash,
      );
    });
  }

  /** Allowlist, ledger height, and every network-free check. */
  private async check(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Static | Invalid> {
    if (requirements.network !== this.network) return { ok: false, reason: "invalid_network" };
    if (!this.allowedAssets.has(requirements.asset)) {
      return { ok: false, reason: "invalid_exact_stellar_payload_asset_not_allowed" };
    }
    let currentLedger: number;
    let estimatedLedgerSeconds: number;
    try {
      [currentLedger, estimatedLedgerSeconds] = await Promise.all([
        this.chain.getLatestLedger(),
        this.chain.estimatedLedgerSeconds(),
      ]);
    } catch (err) {
      this.log("ledger lookup failed", err);
      return { ok: false, reason: "unexpected_verify_error" };
    }
    const s = verifyStatic(payload, requirements, {
      networkPassphrase: this.networkPassphrase,
      facilitatorAddresses: this.facilitatorAddresses,
      currentLedger,
      estimatedLedgerSeconds,
      nonceStore: this.nonces,
    });
    if (!s.ok) {
      if (s.message) this.log(`static check ${s.reason}: ${s.message}`);
      return {
        ok: false,
        reason: s.reason,
        ...(s.payer ? { payer: s.payer } : {}),
        ...(s.nonce ? { nonce: s.nonce } : {}),
      };
    }
    return s;
  }

  /** Rebuild with this facilitator as source, simulate, inspect balance changes and fee. */
  private async prepare(s: Static, requirements: PaymentRequirements): Promise<Prepared | Invalid> {
    let account: Account;
    try {
      account = await this.chain.getAccount(this.address);
    } catch (err) {
      this.log("facilitator account lookup failed", err);
      return { ok: false, reason: "unexpected_verify_error", payer: s.payer };
    }
    const rebuilt = new TransactionBuilder(account, {
      fee: String(this.inclusionFeeStroops),
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({ func: s.invokeOp.func, auth: s.invokeOp.auth ?? [] }))
      .setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
      .build();

    const expected: TransferEvent = {
      asset: requirements.asset,
      from: s.payer,
      to: requirements.payTo,
      amount: BigInt(requirements.amount),
    };
    let sim;
    try {
      sim = await this.chain.simulate(rebuilt, expected);
    } catch (err) {
      this.log("simulation request failed", err);
      return { ok: false, reason: "invalid_exact_stellar_payload_simulation_failed", payer: s.payer };
    }
    if (!sim.ok) {
      this.log(`simulation error: ${sim.error}`);
      return { ok: false, reason: "invalid_exact_stellar_payload_simulation_failed", payer: s.payer };
    }
    const settlementFee = Number.parseInt(sim.minResourceFee, 10) + this.inclusionFeeStroops;
    if (settlementFee > this.maxTransactionFeeStroops) {
      this.log(`fee ${settlementFee} exceeds ceiling ${this.maxTransactionFeeStroops}`);
      return { ok: false, reason: "invalid_exact_stellar_payload_fee_exceeds_maximum", payer: s.payer };
    }
    const eventError = checkTransfers(sim.transfers, expected);
    if (eventError) return { ok: false, reason: eventError, payer: s.payer };
    return { ok: true, rebuilt, assemble: sim.assemble };
  }

  private safeLookup(s: Static): string {
    try {
      return this.nonces.lookup(this.network, s.payer, s.nonce) ?? "";
    } catch {
      return "";
    }
  }

  private safeRelease(s: Static): void {
    try {
      this.nonces.release(this.network, s.payer, s.nonce);
    } catch (err) {
      this.log("nonce release failed", err);
    }
  }
}

function invalid(i: Invalid): VerifyResponse {
  return { isValid: false, invalidReason: i.reason, ...(i.payer ? { payer: i.payer } : {}) };
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
