import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Account, Keypair, xdr, type Transaction } from "@stellar/stellar-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { RpcChainClient, type ChainClient, type SimulationResult, type TransferEvent } from "../src/chain.js";
import { StellarFacilitator } from "../src/facilitator.js";
import { SqliteNonceStore } from "../src/nonce-store.js";
import { envInt, facilitatorFromEnv } from "../src/server.js";
import { CURRENT_LEDGER, USDC_TESTNET, facilitator, requirements, signedPayload } from "./helpers.js";
import { MockChain } from "./mock-chain.js";

const mk = (chain: ChainClient, extra: Partial<ConstructorParameters<typeof StellarFacilitator>[0]> = {}) =>
  new StellarFacilitator({ network: "stellar:testnet", signer: facilitator, chain, nonceStore: new SqliteNonceStore(":memory:"), log: () => {}, ...extra });

const servers: Server[] = [];
const sockets = new Set<Socket>();
afterAll(() => {
  for (const s of sockets) s.destroy();
  for (const s of servers) s.close();
});
async function listen(handler: (body: string, n: number, res: import("node:http").ServerResponse) => void): Promise<string> {
  let n = 0;
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => handler(body, n++, res));
  });
  srv.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

describe("I-1r3 a retried send that ends in ERROR is ambiguous", () => {
  it("transport failure then ERROR txBAD_SEQ -> status AMBIGUOUS with the local hash; the facilitator keeps the claim and returns the hash", async () => {
    const badSeq = new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString("100"),
      result: xdr.TransactionResultResult.txBadSeq(),
      ext: xdr.TransactionResultExt.v0(),
    }).toXDR("base64");
    const url = await listen((body, n, res) => {
      const msg = JSON.parse(body) as { id: unknown };
      if (n === 0) {
        res.socket?.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { status: "ERROR", hash: "", latestLedger: 1, latestLedgerCloseTime: "0", errorResultXdr: badSeq } }),
      );
    });
    const real = new RpcChainClient({ network: "stellar:testnet", rpcUrl: url, horizonUrl: url, timeoutMs: 2000 });
    class Chain extends MockChain {
      override send(tx: Transaction) {
        return real.send(tx);
      }
    }
    const chain = new Chain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    const f = mk(chain);
    const req = requirements();
    const p = await signedPayload(req);
    const r = await f.settle(p, req, { claimKey: "claim-retry-0001" });
    expect(r.success).toBe(false);
    expect(r.errorReason).toBe("unexpected_settle_error");
    expect(r.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect((await f.verify(p, req)).invalidReason).toBe("invalid_exact_stellar_payload_nonce_reused");
  }, 30_000);

  it("a clean first-attempt ERROR still releases the claim", async () => {
    const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey(), sendStatus: "ERROR" });
    const f = mk(chain);
    const req = requirements();
    const p = await signedPayload(req);
    expect((await f.settle(p, req)).errorReason).toBe("settle_exact_stellar_transaction_submission_failed");
    expect((await f.verify(p, req)).isValid).toBe(true);
  });
});

describe("I-3r3 strict numeric environment", () => {
  const base = { FACILITATOR_SECRET: Keypair.random().secret(), NONCE_DB_PATH: ":memory:", STELLAR_RPC_URL: "http://127.0.0.1:9", STELLAR_HORIZON_URL: "http://127.0.0.1:9" };
  it.each([
    ["FEE_BUDGET_STROOPS_PER_HOUR", "5,000,000"],
    ["FEE_BUDGET_STROOPS_PER_HOUR", "0.5 XLM"],
    ["MAX_SETTLES_PER_SELLER_PER_HOUR", "600/h"],
    ["MAX_TRANSACTION_FEE_STROOPS", "50_000"],
    ["FEE_BUDGET_PER_SELLER_STROOPS_PER_HOUR", "-1"],
  ])("%s=%s refuses to start", (k, v) => {
    expect(() => facilitatorFromEnv({ ...base, [k]: v })).toThrow(/plain non-negative integer/);
  });
  it("plain integers and blanks are accepted", () => {
    const f = facilitatorFromEnv({ ...base, FEE_BUDGET_STROOPS_PER_HOUR: " 4000000 ", MAX_SETTLES_PER_SELLER_PER_HOUR: "", FEE_BUDGET_PER_SELLER_STROOPS_PER_HOUR: "500000" });
    expect(f.feeBudgetStroopsPerHour).toBe(4_000_000);
    expect(f.maxSettlesPerSellerPerHour).toBe(600);
    expect(f.feeBudgetPerSellerStroopsPerHour).toBe(500_000);
    expect(envInt({ X: "0" }, "X")).toBe(0);
  });
  it("a non-integer option passed in code fails closed to 0, not off", async () => {
    const f = mk(new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() }), { feeBudgetStroopsPerHour: Number("5,000,000") });
    expect(f.feeBudgetStroopsPerHour).toBe(0);
    const req = requirements();
    expect((await f.settle(await signedPayload(req), req)).errorReason).toBe("fee_budget_exhausted");
  });
});

describe("I-4r3 per-seller fee share", () => {
  it("defaults to a quarter of the global budget, never below one maximum-fee settlement", () => {
    const chain = () => new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    expect(mk(chain()).feeBudgetPerSellerStroopsPerHour).toBe(1_250_000);
    // The share floors at maxTransactionFeeStroops but is clamped to the budget itself: with 1,000 the share is 1,000.
    expect(mk(chain(), { feeBudgetStroopsPerHour: 1_000 }).feeBudgetPerSellerStroopsPerHour).toBe(1_000);
    expect(mk(chain(), { feeBudgetStroopsPerHour: 1_000_000, maxTransactionFeeStroops: 50_000 }).feeBudgetPerSellerStroopsPerHour).toBe(250_000);
    expect(mk(chain(), { feeBudgetStroopsPerHour: 1_000_000, maxTransactionFeeStroops: 10_000 }).feeBudgetPerSellerStroopsPerHour).toBe(250_000);
  });

  it("one seller cannot take the hour from the others: at the demo fee (16,860) it is cut off at its share and a second seller still settles", async () => {
    const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey(), minResourceFee: String(16_860 - 100) });
    const f = mk(chain);
    const attacker = requirements({ payTo: Keypair.random().publicKey(), amount: "1" });
    let n = 0;
    for (; n < 700; n++) {
      const r = await f.settle(await signedPayload(attacker, { payerKp: Keypair.random() }), attacker);
      if (!r.success) {
        expect(r.errorReason).toBe("seller_fee_budget_exhausted");
        break;
      }
    }
    expect(n).toBe(Math.floor(1_250_000 / 16_860)); // 74
    const victim = requirements();
    expect((await f.settle(await signedPayload(victim, { payerKp: Keypair.random() }), victim)).success).toBe(true);
    expect(f.usage().feeStroopsLastHour).toBe(75 * 16_860);
  });

  it("HTTP answers 429 for the per-seller share as well", async () => {
    const f = mk(new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() }), { feeBudgetPerSellerStroopsPerHour: 1 });
    const req = requirements();
    const res = await createApp(f).request("/settle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paymentPayload: await signedPayload(req), paymentRequirements: req }) });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ errorReason: "seller_fee_budget_exhausted" });
  });
});

describe("M-r3-5 / M-r3-6 bearer mode", () => {
  it("a claim key is scoped to the token that presented it", async () => {
    const f = mk(new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() }));
    const app = createApp(f, { sellerTokens: ["tokA_0123456789abcdef", "tokB_0123456789abcdef"] });
    const req = requirements();
    const body = JSON.stringify({ paymentPayload: await signedPayload(req), paymentRequirements: req });
    const post = (tok: string) =>
      app.request("/settle", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}`, "idempotency-key": "claim-shared-0001" }, body }).then((r) => r.json() as Promise<{ success: boolean; errorReason?: string }>);
    expect((await post("tokA_0123456789abcdef")).success).toBe(true);
    expect((await post("tokA_0123456789abcdef")).success).toBe(true);
    expect(await post("tokB_0123456789abcdef")).toMatchObject({ success: false, errorReason: "invalid_exact_stellar_payload_nonce_reused" });
  });

  it("tokens of different lengths are compared without length leaks (both wrong -> 401; both right -> 200)", async () => {
    const f = mk(new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() }));
    const app = createApp(f, { sellerTokens: ["short-tok-1", "a-much-longer-token-value-0123456789"] });
    const req = requirements();
    const body = async () => JSON.stringify({ paymentPayload: await signedPayload(req, { payerKp: Keypair.random() }), paymentRequirements: req });
    for (const [tok, status] of [["short-tok-1", 200], ["a-much-longer-token-value-0123456789", 200], ["short-tok-2", 401], ["x", 401]] as const) {
      const res = await app.request("/verify", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: await body() });
      expect(res.status).toBe(status);
    }
  });
});

describe("M-r3-7 a never-submitted claim is released once the entry has expired on chain", () => {
  class Ledger implements ChainClient {
    ledger = CURRENT_LEDGER;
    hang = true;
    async getLatestLedger() {
      return this.ledger;
    }
    async estimatedLedgerSeconds() {
      return 5;
    }
    async getAccount(a: string) {
      return new Account(a, "1");
    }
    async simulate(_t: Transaction, e: TransferEvent): Promise<SimulationResult> {
      return { ok: true, minResourceFee: "1000", transfers: [e], assemble: (t) => t };
    }
    async send(tx: Transaction) {
      if (this.hang) return new Promise<{ status: string; hash: string }>(() => undefined);
      return { status: "PENDING", hash: Buffer.from(tx.hash()).toString("hex") };
    }
    async waitForTransaction() {
      return { status: "SUCCESS" };
    }
  }
  it("claimed row + expired entry -> released; the buyer signs a fresh entry and pays normally", async () => {
    const chain = new Ledger();
    const f = mk(chain, { settleDeadlineMs: 200 });
    const req = requirements();
    const p = await signedPayload(req, { validUntilLedgerSeq: CURRENT_LEDGER + 5 });
    const r1 = await f.settle(p, req, { claimKey: "owner-key-00001" });
    expect(r1.errorReason).toBe("unexpected_settle_error");
    expect((await f.verify(p, req)).invalidReason).toBe("invalid_exact_stellar_payload_nonce_reused");
    chain.ledger = CURRENT_LEDGER + 5; // the entry's expiration ledger has arrived: it can never be applied now
    const v = await f.verify(p, req);
    expect(v.invalidReason).toBe("invalid_exact_stellar_signature_expired"); // released, and the entry itself is stale
    chain.hang = false;
    const fresh = await signedPayload(req, { validUntilLedgerSeq: CURRENT_LEDGER + 15 }); // within +14 of the new ledger (+5)
    expect((await f.settle(fresh, req)).success).toBe(true);
  });
});

describe("allowlist strkey check unchanged by r3", () => {
  it("still refuses a G account and lowercase", () => {
    const chain = new MockChain({ currentLedger: CURRENT_LEDGER, facilitatorAddress: facilitator.publicKey() });
    expect(() => mk(chain, { allowedAssets: [Keypair.random().publicKey()] })).toThrow(/strkey/);
    expect(() => mk(chain, { allowedAssets: [USDC_TESTNET.toLowerCase()] })).toThrow(/strkey/);
  });
});
