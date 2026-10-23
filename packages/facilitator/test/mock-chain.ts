import { Account, type Transaction } from "@stellar/stellar-sdk";
import type { ChainClient, SimulationResult, TransferEvent } from "../src/chain.js";

export interface MockChainOptions {
  currentLedger: number;
  facilitatorAddress: string;
  /** Transfers the mock "simulation" reports; defaults to echoing the request. */
  transfers?: TransferEvent[] | ((tx: Transaction) => TransferEvent[]);
  minResourceFee?: string;
  simulationError?: string;
  sendStatus?: "PENDING" | "ERROR" | "DUPLICATE" | "TRY_AGAIN_LATER";
  finalStatus?: "SUCCESS" | "FAILED" | "NOT_FOUND";
}

export class MockChain implements ChainClient {
  readonly sent: Transaction[] = [];
  sequence = 100n;

  constructor(private readonly o: MockChainOptions) {}

  async getLatestLedger(): Promise<number> {
    return this.o.currentLedger;
  }

  async estimatedLedgerSeconds(): Promise<number> {
    return 5;
  }

  async getAccount(address: string): Promise<Account> {
    if (address !== this.o.facilitatorAddress) throw new Error(`unknown account ${address}`);
    return new Account(address, (this.sequence++).toString());
  }

  async simulate(tx: Transaction, expected: TransferEvent): Promise<SimulationResult> {
    if (this.o.simulationError) return { ok: false, error: this.o.simulationError };
    const transfers =
      typeof this.o.transfers === "function"
        ? this.o.transfers(tx)
        : (this.o.transfers ?? [expected]);
    return {
      ok: true,
      minResourceFee: this.o.minResourceFee ?? "1000",
      transfers,
      assemble: (t) => t,
    };
  }

  async send(tx: Transaction): Promise<{ status: string; hash: string; error?: string }> {
    this.sent.push(tx);
    const status = this.o.sendStatus ?? "PENDING";
    return {
      status,
      hash: Buffer.from(tx.hash()).toString("hex"),
      ...(status !== "PENDING" ? { error: `mock send ${status}` } : {}),
    };
  }

  async waitForTransaction(_hash: string, _timeoutSeconds: number): Promise<{ status: string }> {
    return { status: this.o.finalStatus ?? "SUCCESS" };
  }
}
