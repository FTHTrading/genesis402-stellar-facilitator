import {
  Account,
  Address,
  Horizon,
  StrKey,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  DEFAULT_ESTIMATED_LEDGER_SECONDS,
  DEFAULT_HORIZON_URLS,
  DEFAULT_RPC_URLS,
} from "./constants.js";
import { isTransientError, withRetry } from "./retry.js";

/** One SEP-41 `transfer` event observed in simulation (CAP-46-6: topics [transfer, from, to], data amount). */
export interface TransferEvent {
  asset: string;
  from: string;
  to: string;
  amount: bigint;
}

export type SimulationResult =
  | {
      ok: true;
      minResourceFee: string;
      transfers: TransferEvent[];
      /** Applies the simulation's footprint and resource fee to the transaction. */
      assemble: (tx: Transaction) => Transaction;
    }
  | { ok: false; error: string };

/**
 * The slice of the network the facilitator depends on. `RpcChainClient` is
 * the real implementation; tests substitute a mock.
 */
export interface ChainClient {
  getLatestLedger(): Promise<number>;
  estimatedLedgerSeconds(): Promise<number>;
  getAccount(address: string): Promise<Account>;
  simulate(tx: Transaction, expected: TransferEvent): Promise<SimulationResult>;
  send(tx: Transaction): Promise<{ status: string; hash: string; error?: string }>;
  waitForTransaction(hash: string, timeoutSeconds: number): Promise<{ status: string }>;
}

export interface RpcChainClientOptions {
  network: string;
  rpcUrl?: string;
  horizonUrl?: string;
  /** Per-request timeout for RPC and Horizon calls (ms). Default 20 s; a hung node must not hold a settlement. */
  timeoutMs?: number;
}

export const DEFAULT_RPC_TIMEOUT_MS = 20_000;

/** Turns one diagnostic event into a TransferEvent when it is a SEP-41 transfer; otherwise undefined. */
export function parseTransferEvent(ev: xdr.DiagnosticEvent): TransferEvent | undefined {
  const event = ev.event;
  if (event.type !== xdr.ContractEventType.contract || !event.contractId) return undefined;
  const v0 = event.body.v0;
  const topics = v0.topics;
  if (topics.length < 3) return undefined;
  const first = topics[0]!;
  if (first.type !== "scvSymbol") return undefined;
  if (String(scValToNative(first)) !== "transfer") return undefined;
  const asset = contractIdToStrKey(event.contractId);
  const from = scValToNative(topics[1]!);
  const to = scValToNative(topics[2]!);
  // Protocol 23+ SAC events may carry data as a map {amount, to_muxed_id}; older ones carry the bare i128.
  const data: unknown = scValToNative(v0.data);
  const amount =
    typeof data === "bigint"
      ? data
      : data && typeof data === "object" && "amount" in data
        ? (data as { amount: bigint }).amount
        : undefined;
  if (typeof from !== "string" || typeof to !== "string" || typeof amount !== "bigint") return undefined;
  return { asset, from, to, amount };
}

function contractIdToStrKey(id: xdr.ContractId): string {
  const raw = (id as unknown as { toXDR?: () => Uint8Array; bytes?: Uint8Array });
  const bytes = raw.bytes ?? (raw.toXDR ? raw.toXDR() : (id as unknown as Uint8Array));
  return StrKey.encodeContract(bytes);
}

/** Balance changes the simulation would cause, as SEP-41 transfer events. */
export function transfersFromEvents(events: readonly xdr.DiagnosticEvent[]): TransferEvent[] {
  const out: TransferEvent[] = [];
  for (const ev of events) {
    const t = parseTransferEvent(ev);
    if (t) out.push(t);
  }
  return out;
}

export class RpcChainClient implements ChainClient {
  readonly server: rpc.Server;
  readonly horizon: Horizon.Server;

  constructor(opts: RpcChainClientOptions) {
    const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URLS[opts.network];
    if (!rpcUrl) throw new Error(`No Soroban RPC URL for ${opts.network}; set STELLAR_RPC_URL`);
    const horizonUrl = opts.horizonUrl ?? DEFAULT_HORIZON_URLS[opts.network];
    if (!horizonUrl) throw new Error(`No Horizon URL for ${opts.network}; set STELLAR_HORIZON_URL`);
    const timeout = opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://"), timeout });
    this.horizon = new Horizon.Server(horizonUrl, { allowHttp: horizonUrl.startsWith("http://") });
    this.horizon.httpClient.defaults.timeout = timeout;
  }

  async getLatestLedger(): Promise<number> {
    return (await withRetry(() => this.server.getLatestLedger())).sequence;
  }

  /** Average close time over the last 20 ledgers (Horizon), falling back to 5 seconds. */
  async estimatedLedgerSeconds(): Promise<number> {
    try {
      const page = await this.horizon.ledgers().limit(20).order("desc").call();
      const records = page.records;
      if (records.length < 2) return DEFAULT_ESTIMATED_LEDGER_SECONDS;
      const newest = Date.parse(records[0]!.closed_at) / 1000;
      const oldest = Date.parse(records[records.length - 1]!.closed_at) / 1000;
      const seconds = Math.ceil((newest - oldest) / (records.length - 1));
      return seconds > 0 ? seconds : DEFAULT_ESTIMATED_LEDGER_SECONDS;
    } catch {
      return DEFAULT_ESTIMATED_LEDGER_SECONDS;
    }
  }

  /** Sequence number via RPC, falling back to Horizon when the RPC is unavailable or lagging. */
  async getAccount(address: string): Promise<Account> {
    try {
      return await withRetry(() => this.server.getAccount(address), { attempts: 2 });
    } catch (rpcErr) {
      try {
        const acc = await withRetry(() => this.horizon.loadAccount(address));
        return new Account(acc.account_id, acc.sequence);
      } catch {
        throw rpcErr;
      }
    }
  }

  async simulate(tx: Transaction): Promise<SimulationResult> {
    const sim = await withRetry(() => this.server.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error };
    if (rpc.Api.isSimulationRestore(sim)) {
      return { ok: false, error: "ledger entries need restoration before this transfer can run" };
    }
    return {
      ok: true,
      minResourceFee: sim.minResourceFee,
      transfers: transfersFromEvents(sim.events),
      assemble: (t) => rpc.assembleTransaction(t, sim).build(),
    };
  }

  /**
   * sendTransaction is idempotent for a given envelope (same hash), so a
   * transport failure is retried; a repeat that the node already holds comes
   * back as DUPLICATE and is treated as pending.
   */
  async send(tx: Transaction): Promise<{ status: string; hash: string; error?: string }> {
    const res = await withRetry(() => this.server.sendTransaction(tx));
    if (res.status === "DUPLICATE") return { status: "PENDING", hash: res.hash };
    const error =
      res.status === "ERROR"
        ? `sendTransaction ERROR: ${res.errorResult ? res.errorResult.toXDR("base64") : "no result"}`
        : res.status !== "PENDING"
          ? `sendTransaction ${res.status}`
          : undefined;
    return { status: res.status, hash: res.hash, ...(error ? { error } : {}) };
  }

  async waitForTransaction(hash: string, timeoutSeconds: number): Promise<{ status: string }> {
    const deadline = Date.now() + Math.max(timeoutSeconds, 10) * 1000;
    let status = "NOT_FOUND";
    while (Date.now() < deadline) {
      try {
        status = (await this.server.getTransaction(hash)).status;
      } catch (err) {
        if (!isTransientError(err)) throw err;
      }
      if (status === "SUCCESS" || status === "FAILED") return { status };
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { status };
  }
}

/** Convenience for payer tooling: strkey for a SAC given its classic asset. */
export function addressOf(scAddress: xdr.ScAddress): string {
  return Address.fromScAddress(scAddress).toString();
}
