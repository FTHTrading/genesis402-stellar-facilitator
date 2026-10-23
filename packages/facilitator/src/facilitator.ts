import {
  Keypair,
  Operation,
  StrKey,
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

/** Upper bound on the time one settlement may hold the signer. Past it the lock is released and the result reported as ambiguous. */
export const DEFAULT_SETTLE_DEADLINE_MS = 12_000;
/** How long an idempotent re-read waits for a still-pending transaction before answering `not_confirmed`. */
const REREAD_CONFIRM_SECONDS = 5;

export interface FacilitatorOptions {
  /** CAIP-2 network this instance settles on, e.g. `stellar:testnet`. */
  network: string;
  /** Settlement signer. It pays fees and spends its sequence number; it never holds buyer funds. */
  signer: Keypair;
  chain: ChainClient;
  nonceStore: NonceStore;
  /**
   * Token contracts this facilitator will sponsor. Default: Circle USDC on the
   * network. Anything else is refused at verify (`asset_not_allowed`). Every
   * entry must be a valid contract strkey; the constructor fails closed otherwise.
   */
  allowedAssets?: readonly string[];
  /** Safety ceiling for the simulation-derived fee (stroops). Default 50,000. */
  maxTransactionFeeStroops?: number;
  /** Inclusion fee bid on top of the resource fee (stroops). Default 100. */
  inclusionFeeStroops?: number;
  /** Wall-clock cap on the locked part of a settlement. Default 12 s. */
  settleDeadlineMs?: number;
  /**
   * Fee-drain guard (threat model DoS.6): a hosted facilitator pays fees for
   * anyone, so valid dust payments to an attacker's own seller drain the fee
   * account. Settlement fees charged in the trailing hour may not exceed this
   * budget. Default 5,000,000 stroops (0.5 XLM).
   */
  feeBudgetStroopsPerHour?: number;
  /** Settlements accepted per `payTo` in the trailing hour. Default 600. */
  maxSettlesPerSellerPerHour?: number;
  now?: () => number;
  /** Server-side logger for causes that are never sent to clients. */
  log?: (message: string, err?: unknown) => void;
}

export interface SettleOptions {
  /**
   * Opaque claimant identity (the seller's idempotency key for this payment).
   * A later /settle with the same key for the same entry gets the recorded
   * outcome back; any other key gets `nonce_reused`.
   */
  claimKey?: string;
}

type Static = Extract<StaticResult, { ok: true }>;
type Invalid = { ok: false; reason: string; payer?: string; nonce?: string };
type Prepared = { ok: true; rebuilt: Transaction; assemble: (tx: Transaction) => Transaction; feeStroops: number };

const HOUR_MS = 3_600_000;

/** Sliding one-hour window of (timestamp, weight) entries. */
class HourWindow {
  private entries: Array<{ at: number; w: number }> = [];
  constructor(private readonly now: () => number) {}
  total(): number {
    const cutoff = this.now() - HOUR_MS;
    this.entries = this.entries.filter((e) => e.at > cutoff);
    return this.entries.reduce((s, e) => s + e.w, 0);
  }
  add(w: number): void {
    this.entries.push({ at: this.now(), w });
  }
}

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
 * one sequence number; a second envelope at the same sequence is not admitted),
 * and the locked section is bounded by `settleDeadlineMs` so one stalled RPC
 * call cannot stop every other buyer. Channel accounts are the T2 answer to
 * throughput.
 */
export class StellarFacilitator {
  readonly network: string;
  readonly networkPassphrase: string;
  readonly signer: Keypair;
  readonly address: string;
  readonly allowedAssets: ReadonlySet<string>;
  readonly maxTransactionFeeStroops: number;
  readonly inclusionFeeStroops: number;
  readonly settleDeadlineMs: number;
  readonly feeBudgetStroopsPerHour: number;
  readonly maxSettlesPerSellerPerHour: number;
  private readonly feeWindow: HourWindow;
  private readonly sellerWindows = new Map<string, HourWindow>();
  private readonly now: () => number;
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
    const allowed = (opts.allowedAssets ?? (defaults ? [defaults] : [])).map((a) => a.trim()).filter(Boolean);
    if (allowed.length === 0) throw new Error("allowedAssets must name at least one token contract");
    for (const a of allowed) {
      if (!StrKey.isValidContract(a)) throw new Error(`allowedAssets entry is not a contract strkey: ${a}`);
    }
    this.allowedAssets = new Set(allowed);
    this.maxTransactionFeeStroops = opts.maxTransactionFeeStroops ?? DEFAULT_MAX_TRANSACTION_FEE_STROOPS;
    this.inclusionFeeStroops = opts.inclusionFeeStroops ?? DEFAULT_INCLUSION_FEE_STROOPS;
    this.settleDeadlineMs = opts.settleDeadlineMs ?? DEFAULT_SETTLE_DEADLINE_MS;
    this.feeBudgetStroopsPerHour = opts.feeBudgetStroopsPerHour ?? 5_000_000;
    this.maxSettlesPerSellerPerHour = opts.maxSettlesPerSellerPerHour ?? 600;
    this.now = opts.now ?? (() => Date.now());
    this.feeWindow = new HourWindow(this.now);
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

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    options: SettleOptions = {},
  ): Promise<SettleResponse> {
    const network = payload.accepted?.network ?? requirements.network;
    const claimKey = options.claimKey ?? "";
    const failed = (errorReason: string, payer?: string, transaction = ""): SettleResponse => ({
      success: false,
      errorReason,
      transaction,
      network,
      ...(payer ? { payer } : {}),
    });

    const s = await this.check(payload, requirements);
    if (!s.ok) {
      if (s.reason === "invalid_exact_stellar_payload_nonce_reused" && s.payer && s.nonce) {
        return this.reread(s.payer, s.nonce, claimKey, network, requirements);
      }
      return failed(s.reason, s.payer);
    }

    return this.lock.run(() => this.critical(s, requirements, claimKey, network, failed));
  }

  /**
   * The locked part: rebuild, simulate, claim, submit, confirm. Bounded by the
   * deadline; when it fires the lock is released and the outcome reported from
   * how far the section got. A claim made before the deadline is kept (the
   * envelope may have reached a node); a section that never claimed leaves the
   * buyer's entry untouched.
   */
  private async critical(
    s: Static,
    requirements: PaymentRequirements,
    claimKey: string,
    network: string,
    failed: (reason: string, payer?: string, transaction?: string) => SettleResponse,
  ): Promise<SettleResponse> {
    const state = { phase: "preparing" as "preparing" | "claimed" | "submitted" | "done", hash: "", aborted: false };
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<SettleResponse>((resolve) => {
      timer = setTimeout(() => {
        state.aborted = true;
        this.log(`settle deadline (${this.settleDeadlineMs} ms) hit in phase ${state.phase} for ${s.payer}`);
        if (state.phase === "submitted") {
          resolve(failed("settle_exact_stellar_transaction_not_confirmed", s.payer, state.hash));
        } else if (state.phase === "claimed") {
          resolve(failed("unexpected_settle_error", s.payer, state.hash));
        } else {
          resolve(failed("unexpected_settle_error", s.payer));
        }
      }, this.settleDeadlineMs);
    });
    const body = (async (): Promise<SettleResponse> => {
      const p = await this.prepare(s, requirements);
      if (!p.ok) return failed(p.reason, s.payer);
      if (state.aborted) return failed("unexpected_settle_error", s.payer);

      // Fee-drain guard: the hour's fee budget and the seller's hourly count, checked before any claim.
      if (this.feeWindow.total() + p.feeStroops > this.feeBudgetStroopsPerHour) {
        this.log(`fee budget exhausted: ${this.feeWindow.total()} + ${p.feeStroops} > ${this.feeBudgetStroopsPerHour}`);
        return failed("fee_budget_exhausted", s.payer);
      }
      const sellerWindow = this.sellerWindow(requirements.payTo);
      if (sellerWindow.total() + 1 > this.maxSettlesPerSellerPerHour) {
        this.log(`seller cap reached for ${requirements.payTo}`);
        return failed("seller_rate_limited", s.payer);
      }

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
        claimed = this.nonces.consume(this.network, s.payer, s.nonce, hash, claimKey);
      } catch (err) {
        this.log("nonce store unavailable at claim", err);
        return failed("nonce_store_unavailable", s.payer);
      }
      if (!claimed) return this.reread(s.payer, s.nonce, claimKey, network, requirements);
      state.phase = "claimed";
      state.hash = hash;
      if (state.aborted) {
        // Deadline fired between claim and send: nothing was submitted, so the entry is unspent.
        this.safeRelease(s);
        return failed("unexpected_settle_error", s.payer);
      }

      let sent: { status: string; hash: string; error?: string };
      try {
        sent = await this.chain.send(tx);
      } catch (err) {
        // Ambiguous: the envelope may have reached a node. Keep the claim; report the hash for reconciliation.
        this.log(`sendTransaction threw for ${hash}`, err);
        this.safeStatus(s, "submitted");
        return failed("unexpected_settle_error", s.payer, hash);
      }
      if (sent.status !== "PENDING") {
        // ERROR and TRY_AGAIN_LATER mean the network did not admit this envelope: the entry is unspent.
        if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") this.safeRelease(s);
        this.log(`sendTransaction ${sent.status} for ${hash}: ${sent.error ?? ""}`);
        return failed("settle_exact_stellar_transaction_submission_failed", s.payer);
      }
      hash = sent.hash;
      state.phase = "submitted";
      state.hash = hash;
      this.safeStatus(s, "submitted", hash);
      // The fee is spent once the network admits the envelope, whatever happens afterwards.
      this.feeWindow.add(p.feeStroops);
      sellerWindow.add(1);

      let final: { status: string };
      try {
        final = await this.chain.waitForTransaction(hash, requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
      } catch (err) {
        this.log(`confirmation poll failed for ${hash}`, err);
        return failed("settle_exact_stellar_transaction_not_confirmed", s.payer, hash);
      }
      if (final.status === "SUCCESS") {
        this.safeStatus(s, "confirmed");
        return { success: true, transaction: hash, network, payer: s.payer, amount: requirements.amount };
      }
      if (final.status === "FAILED") {
        this.safeStatus(s, "failed");
        return failed("settle_exact_stellar_transaction_failed", s.payer, hash);
      }
      return failed("settle_exact_stellar_transaction_not_confirmed", s.payer, hash);
    })();
    try {
      return await Promise.race([body, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      state.phase = "done";
      body.catch(() => undefined);
    }
  }

  /**
   * The entry is already claimed. The claimant that made the claim (same
   * `claimKey`) may read its outcome again; everyone else is told the entry is
   * spent, with the paying transaction so a seller can check the chain.
   * Delivery is never granted here to a different claimant.
   */
  private async reread(
    payer: string,
    nonce: string,
    claimKey: string,
    network: string,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    let rec;
    try {
      rec = this.nonces.lookup(this.network, payer, nonce);
    } catch {
      rec = undefined;
    }
    const refused: SettleResponse = {
      success: false,
      errorReason: "invalid_exact_stellar_payload_nonce_reused",
      transaction: rec?.txHash ?? "",
      network,
      payer,
    };
    if (!rec || !claimKey || rec.claimKey !== claimKey) return refused;
    if (rec.status === "confirmed") {
      return { success: true, transaction: rec.txHash, network, payer, amount: requirements.amount };
    }
    if (rec.status === "failed") {
      return { success: false, errorReason: "settle_exact_stellar_transaction_failed", transaction: rec.txHash, network, payer };
    }
    // claimed or submitted: the original section may still be running or may have lost its answer. Look once more.
    try {
      const final = await this.chain.waitForTransaction(rec.txHash, REREAD_CONFIRM_SECONDS);
      if (final.status === "SUCCESS") {
        this.safeSetStatus(payer, nonce, "confirmed");
        return { success: true, transaction: rec.txHash, network, payer, amount: requirements.amount };
      }
      if (final.status === "FAILED") {
        this.safeSetStatus(payer, nonce, "failed");
        return { success: false, errorReason: "settle_exact_stellar_transaction_failed", transaction: rec.txHash, network, payer };
      }
    } catch (err) {
      this.log(`re-read confirmation failed for ${rec.txHash}`, err);
    }
    return { success: false, errorReason: "settle_exact_stellar_transaction_not_confirmed", transaction: rec.txHash, network, payer };
  }

  /** Allowlist, ledger height, and every network-free check. */
  private async check(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Static | Invalid> {
    if (requirements.network !== this.network) return { ok: false, reason: "invalid_network" };
    if (!this.allowedAssets.has(requirements.asset) || payload.accepted?.asset !== requirements.asset) {
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
    return { ok: true, rebuilt, assemble: sim.assemble, feeStroops: settlementFee };
  }

  /** Fees charged in the trailing hour (stroops) and settlements per seller; exposed for /health. */
  usage(): { feeStroopsLastHour: number; feeBudgetStroopsPerHour: number } {
    return { feeStroopsLastHour: this.feeWindow.total(), feeBudgetStroopsPerHour: this.feeBudgetStroopsPerHour };
  }

  private sellerWindow(payTo: string): HourWindow {
    let w = this.sellerWindows.get(payTo);
    if (!w) {
      if (this.sellerWindows.size > 10_000) this.sellerWindows.delete(this.sellerWindows.keys().next().value!);
      w = new HourWindow(this.now);
      this.sellerWindows.set(payTo, w);
    }
    return w;
  }

  private safeRelease(s: Static): void {
    try {
      this.nonces.release(this.network, s.payer, s.nonce);
    } catch (err) {
      this.log("nonce release failed", err);
    }
  }

  private safeStatus(s: Static, status: "submitted" | "confirmed" | "failed", hash?: string): void {
    this.safeSetStatus(s.payer, s.nonce, status, hash);
  }

  private safeSetStatus(payer: string, nonce: string, status: "submitted" | "confirmed" | "failed", hash?: string): void {
    try {
      this.nonces.setStatus(this.network, payer, nonce, status, hash);
    } catch (err) {
      this.log("nonce status update failed", err);
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
