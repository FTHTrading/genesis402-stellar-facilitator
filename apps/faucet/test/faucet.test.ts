import { Keypair, Networks, StrKey, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk/base";
import { beforeEach, describe, expect, it } from "vitest";
import { createFaucet, G402T_CLAIM_AMOUNT, type FaucetConfig } from "../src/faucet.js";
import { ClaimLimiter } from "../src/ratelimit.js";
import { sqliteD1 } from "./sqlite-d1.js";

const DAY = 24 * 60 * 60 * 1000;
const HORIZON = "https://horizon.test";
const FRIENDBOT = "https://friendbot.test";

const issuer = Keypair.random();
const distributor = Keypair.random();

const config: FaucetConfig = {
  networkPassphrase: Networks.TESTNET,
  horizonUrl: HORIZON,
  friendbotUrl: FRIENDBOT,
  explorerTxBase: "https://stellar.expert/explorer/testnet/tx/",
  asset: { code: "G402T", issuer: issuer.publicKey(), sac: StrKey.encodeContract(new Uint8Array(32).fill(1) as never) },
  distributor: distributor.publicKey(),
  xlmSac: StrKey.encodeContract(new Uint8Array(32).fill(2) as never),
  usdc: { sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", faucetUrl: "https://faucet.circle.com" },
};

interface AccountFixture {
  status?: number;
  balances?: Array<Record<string, string>>;
}

/** Records every outbound call and every log line so S3/S4 can be asserted. */
class World {
  calls: Array<{ method: string; url: string; body?: string }> = [];
  logs: string[] = [];
  accounts = new Map<string, AccountFixture>();
  submitted: Transaction[] = [];
  submitResponses: Array<{ status: number; body: unknown }> = [];
  friendbot: { status: number; body: unknown } = { status: 200, body: { hash: "f".repeat(64), successful: true } };
  accountError: Error | null = null;
  seq = 100n;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : undefined;
    this.calls.push({ method, url, body });
    if (url.startsWith(FRIENDBOT)) return json(this.friendbot.body, this.friendbot.status);
    if (url.startsWith(`${HORIZON}/accounts/`)) {
      if (this.accountError) throw this.accountError;
      const id = decodeURIComponent(url.slice(`${HORIZON}/accounts/`.length));
      const fx = this.accounts.get(id);
      if (!fx) return json({ status: 404, title: "Resource Missing" }, 404);
      if (fx.status && fx.status !== 200) return json({ title: "boom" }, fx.status);
      return json({ id, sequence: String(this.seq), balances: fx.balances ?? [] });
    }
    if (url === `${HORIZON}/transactions` && method === "POST") {
      const xdr = new URLSearchParams(body ?? "").get("tx") ?? "";
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
      this.submitted.push(tx);
      const next = this.submitResponses.shift();
      if (next) return json(next.body, next.status);
      this.seq += 1n;
      return json({ hash: tx.hash().toString("hex"), successful: true }, 200);
    }
    return json({ error: "unexpected" }, 599);
  };

  withTrustline(address: string, balance = "0.0000000", limit = "922337203685.4775807") {
    this.accounts.set(address, {
      balances: [
        { asset_type: "native", balance: "10000.0000000" },
        { asset_type: "credit_alphanum12", asset_code: "G402T", asset_issuer: issuer.publicKey(), balance, limit },
      ],
    });
  }
  withoutTrustline(address: string) {
    this.accounts.set(address, { balances: [{ asset_type: "native", balance: "10000.0000000" }] });
  }
  distributorBalance(balance: string) {
    this.withTrustline(distributor.publicKey(), balance);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let world: World;
let clock: number;
let faucet: ReturnType<typeof createFaucet>;
const responses: string[] = [];

function build(opts: { secret?: string | undefined; perAddress?: number; perIp?: number } = {}) {
  const limiter = new ClaimLimiter(sqliteD1(), {
    windowMs: DAY,
    perAddress: opts.perAddress ?? 1,
    perIp: opts.perIp ?? 1,
  });
  return createFaucet({
    config,
    limiter,
    fetch: world.fetch as typeof fetch,
    distributorSecret: "secret" in opts ? opts.secret : distributor.secret(),
    now: () => clock,
    log: (line) => world.logs.push(line),
  });
}

async function post(path: string, body: unknown, ip = "1.2.3.4", contentType = "application/json") {
  const res = await faucet.handle(
    new Request(`https://faucet.test${path}`, {
      method: "POST",
      headers: { "content-type": contentType, "cf-connecting-ip": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  responses.push(text);
  return { status: res.status, headers: res.headers, body: JSON.parse(text) as Record<string, any> };
}

beforeEach(() => {
  world = new World();
  clock = 1_800_000_000_000;
  world.distributorBalance("1000000000.0000000");
  faucet = build();
});

describe("GET /api/info", () => {
  it("returns public asset data", async () => {
    const res = await faucet.handle(new Request("https://faucet.test/api/info"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.asset).toEqual(config.asset);
    expect(body.claimAmount).toBe(G402T_CLAIM_AMOUNT);
    expect(body.distributor).toBe(distributor.publicKey());
    expect(JSON.stringify(body)).not.toContain(distributor.secret());
  });
});

describe("POST /api/claim/g402t", () => {
  it("pays exactly 1,000 G402T from the distributor to the pasted address", async () => {
    const user = Keypair.random().publicKey();
    world.withTrustline(user);
    const r = await post("/api/claim/g402t", { address: user });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.explorer).toBe(`${config.explorerTxBase}${r.body.hash}`);
    expect(world.submitted).toHaveLength(1);
    const tx = world.submitted[0]!;
    expect(tx.source).toBe(distributor.publicKey());
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0] as any;
    expect(op.type).toBe("payment");
    expect(op.destination).toBe(user);
    expect(op.amount).toBe("1000.0000000");
    expect(op.asset.getCode()).toBe("G402T");
    expect(op.asset.getIssuer()).toBe(issuer.publicKey());
    expect(op.source).toBeUndefined();
    expect(tx.signatures).toHaveLength(1);
    expect(distributor.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
  });

  it("S1: extra fields (amount, asset, destination, source) cannot change what is sent", async () => {
    const user = Keypair.random().publicKey();
    const attacker = Keypair.random().publicKey();
    world.withTrustline(user);
    world.withTrustline(attacker);
    const r = await post("/api/claim/g402t", {
      address: user,
      amount: "999999999",
      asset: "XLM",
      assetCode: "USDC",
      issuer: attacker,
      destination: attacker,
      source: attacker,
      memo: "x",
      fee: "100000000",
    });
    expect(r.status).toBe(200);
    const tx = world.submitted[0]!;
    const op = tx.operations[0] as any;
    expect(tx.source).toBe(distributor.publicKey());
    expect(op.destination).toBe(user);
    expect(op.amount).toBe("1000.0000000");
    expect(op.asset.getCode()).toBe("G402T");
    expect(op.asset.getIssuer()).toBe(issuer.publicKey());
    expect(Number(tx.fee)).toBeLessThanOrEqual(10_000);
    expect(world.calls.some((c) => c.url.includes(attacker))).toBe(false);
  });

  it("S1: a query string cannot change the address or amount", async () => {
    const user = Keypair.random().publicKey();
    const attacker = Keypair.random().publicKey();
    world.withTrustline(user);
    const res = await faucet.handle(
      new Request(`https://faucet.test/api/claim/g402t?address=${attacker}&amount=5000`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "1.1.1.1" },
        body: JSON.stringify({ address: user }),
      }),
    );
    expect(res.status).toBe(200);
    const op = world.submitted[0]!.operations[0] as any;
    expect(op.destination).toBe(user);
    expect(op.amount).toBe("1000.0000000");
  });

  it("missing trustline: 409 with the exact fix, nothing sent, slot released", async () => {
    const user = Keypair.random().publicKey();
    world.withoutTrustline(user);
    const r = await post("/api/claim/g402t", { address: user });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("no_trustline");
    expect(r.body.fix).toEqual({
      operation: "change_trust",
      assetCode: "G402T",
      assetIssuer: issuer.publicKey(),
      account: user,
    });
    expect(r.body.message).toContain("G402T");
    expect(r.body.message).toContain(issuer.publicKey());
    expect(world.submitted).toHaveLength(0);
    // After adding the trustline the same address and IP can claim.
    world.withTrustline(user);
    expect((await post("/api/claim/g402t", { address: user })).status).toBe(200);
  });

  it("trustline with no room for 1,000 more: 409 trustline_full", async () => {
    const user = Keypair.random().publicKey();
    world.withTrustline(user, "0.0000000", "500.0000000");
    const r = await post("/api/claim/g402t", { address: user });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("trustline_full");
    expect(world.submitted).toHaveLength(0);
  });

  it("account that does not exist: 404 telling the user to get test XLM", async () => {
    const user = Keypair.random().publicKey();
    const r = await post("/api/claim/g402t", { address: user });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("account_not_found");
    expect(r.body.message).toMatch(/XLM/);
    expect(world.submitted).toHaveLength(0);
  });

  it("distributor empty: 503 faucet_empty, slot released", async () => {
    world.distributorBalance("999.9999999");
    const user = Keypair.random().publicKey();
    world.withTrustline(user);
    const r = await post("/api/claim/g402t", { address: user });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("faucet_empty");
    expect(world.submitted).toHaveLength(0);
    world.distributorBalance("5000.0000000");
    expect((await post("/api/claim/g402t", { address: user })).status).toBe(200);
  });

  it("Horizon 500 on account load: 502 horizon_unavailable, slot released", async () => {
    const user = Keypair.random().publicKey();
    world.accounts.set(user, { status: 500 });
    const r = await post("/api/claim/g402t", { address: user });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("horizon_unavailable");
    world.withTrustline(user);
    expect((await post("/api/claim/g402t", { address: user })).status).toBe(200);
  });

  it("Horizon network failure: 502 horizon_unavailable", async () => {
    const user = Keypair.random().publicKey();
    world.accountError = new TypeError("fetch failed");
    const r = await post("/api/claim/g402t", { address: user });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("horizon_unavailable");
  });

  it("submit rejected with result codes: 502 with codes, slot released", async () => {
    const user = Keypair.random().publicKey();
    world.withTrustline(user);
    world.submitResponses.push({
      status: 400,
      body: { extras: { result_codes: { transaction: "tx_failed", operations: ["op_underfunded"] } } },
    });
    const r = await post("/api/claim/g402t", { address: user });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("submit_failed");
    expect(r.body.resultCodes).toEqual({ transaction: "tx_failed", operations: ["op_underfunded"] });
    expect((await post("/api/claim/g402t", { address: user })).status).toBe(200);
  });

  it("tx_bad_seq is retried with a fresh sequence", async () => {
    const user = Keypair.random().publicKey();
    world.withTrustline(user);
    world.submitResponses.push({ status: 400, body: { extras: { result_codes: { transaction: "tx_bad_seq" } } } });
    const r = await post("/api/claim/g402t", { address: user });
    expect(r.status).toBe(200);
    expect(world.submitted).toHaveLength(2);
  });

  it("submit timeout (504): outcome unknown, slot kept so no double send", async () => {
    const user = Keypair.random().publicKey();
    world.withTrustline(user);
    world.submitResponses.push({ status: 504, body: { title: "Timeout" } });
    const r = await post("/api/claim/g402t", { address: user });
    expect(r.status).toBe(504);
    expect(r.body.error).toBe("submit_pending");
    expect(r.body.hash).toMatch(/^[0-9a-f]{64}$/);
    const again = await post("/api/claim/g402t", { address: user });
    expect(again.status).toBe(429);
    expect(world.submitted).toHaveLength(1);
  });

  it("repeat claim within 24h is refused with a clear message and Retry-After", async () => {
    const user = Keypair.random().publicKey();
    world.withTrustline(user);
    expect((await post("/api/claim/g402t", { address: user })).status).toBe(200);
    clock += 60 * 60 * 1000;
    const r = await post("/api/claim/g402t", { address: user }, "5.6.7.8");
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("rate_limited");
    expect(r.body.scope).toBe("address");
    expect(r.body.message).toMatch(/24 hours/);
    expect(r.body.message).toMatch(/23h/);
    expect(Number(r.headers.get("retry-after"))).toBe(23 * 3600);
    expect(world.submitted).toHaveLength(1);
  });

  it("a second address from the same IP is refused", async () => {
    const a = Keypair.random().publicKey();
    const b = Keypair.random().publicKey();
    world.withTrustline(a);
    world.withTrustline(b);
    expect((await post("/api/claim/g402t", { address: a })).status).toBe(200);
    const r = await post("/api/claim/g402t", { address: b });
    expect(r.status).toBe(429);
    expect(r.body.scope).toBe("ip");
  });

  it("S2: 20 parallel claims for one address send exactly once", async () => {
    faucet = build({ perIp: 1000 });
    const user = Keypair.random().publicKey();
    world.withTrustline(user);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post("/api/claim/g402t", { address: user }, `10.0.0.${i}`)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 429)).toHaveLength(19);
    expect(world.submitted).toHaveLength(1);
  });

  it("S2: 20 parallel claims from one IP send exactly once", async () => {
    faucet = build({ perAddress: 1000 });
    const users = Array.from({ length: 20 }, () => Keypair.random().publicKey());
    users.forEach((u) => world.withTrustline(u));
    const results = await Promise.all(users.map((u) => post("/api/claim/g402t", { address: u }, "7.7.7.7")));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(world.submitted).toHaveLength(1);
  });

  it("S4: invalid, muxed, contract and secret addresses are rejected before any outbound call", async () => {
    const inputs = [
      "nope",
      "",
      StrKey.encodeMed25519PublicKey(new Uint8Array(40).fill(3) as never),
      StrKey.encodeContract(new Uint8Array(32).fill(4) as never),
      Keypair.random().secret(),
      Keypair.random().publicKey().toLowerCase(),
    ];
    for (const address of inputs) {
      const r = await post("/api/claim/g402t", { address });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toMatch(/^address_/);
    }
    const missing = await post("/api/claim/g402t", {});
    expect(missing.status).toBe(400);
    const xlm = await post("/api/claim/xlm", { address: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" });
    expect(xlm.status).toBe(400);
    expect(world.calls).toHaveLength(0);
  });

  it("not configured when the distributor secret is absent", async () => {
    faucet = build({ secret: undefined });
    const user = Keypair.random().publicKey();
    world.withTrustline(user);
    const r = await post("/api/claim/g402t", { address: user });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("not_configured");
    expect(world.calls).toHaveLength(0);
  });

  it("not configured when the secret does not match the published distributor", async () => {
    faucet = build({ secret: Keypair.random().secret() });
    const user = Keypair.random().publicKey();
    world.withTrustline(user);
    const r = await post("/api/claim/g402t", { address: user });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("not_configured");
    expect(world.submitted).toHaveLength(0);
  });

  it("not configured when the secret is garbage (no throw, no echo)", async () => {
    faucet = build({ secret: "SNOTAREALKEY" });
    const user = Keypair.random().publicKey();
    world.withTrustline(user);
    const r = await post("/api/claim/g402t", { address: user });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("SNOTAREALKEY");
    expect(world.logs.join("\n")).not.toContain("SNOTAREALKEY");
  });
});

describe("POST /api/claim/xlm", () => {
  it("proxies Friendbot for the pasted address and returns the hash", async () => {
    const user = Keypair.random().publicKey();
    const r = await post("/api/claim/xlm", { address: user, amount: "1000000", addr: "GEVIL" });
    expect(r.status).toBe(200);
    expect(r.body.hash).toBe("f".repeat(64));
    expect(r.body.amount).toBe("10000");
    expect(world.calls).toHaveLength(1);
    expect(world.calls[0]!.url).toBe(`${FRIENDBOT}/?addr=${user}`);
  });

  it("Friendbot 400 means already funded: 409 already_funded, slot released", async () => {
    world.friendbot = { status: 400, body: { detail: "createAccountAlreadyExist" } };
    const user = Keypair.random().publicKey();
    const r = await post("/api/claim/xlm", { address: user });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("already_funded");
    world.friendbot = { status: 200, body: { hash: "e".repeat(64) } };
    expect((await post("/api/claim/xlm", { address: Keypair.random().publicKey() })).status).toBe(200);
  });

  it("Friendbot 5xx: 502 friendbot_unavailable", async () => {
    world.friendbot = { status: 502, body: { title: "bad gateway" } };
    const r = await post("/api/claim/xlm", { address: Keypair.random().publicKey() });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("friendbot_unavailable");
  });

  it("repeat within 24h is refused", async () => {
    const user = Keypair.random().publicKey();
    expect((await post("/api/claim/xlm", { address: user })).status).toBe(200);
    expect((await post("/api/claim/xlm", { address: user }, "8.8.8.8")).status).toBe(429);
  });

  it("works without a distributor secret", async () => {
    faucet = build({ secret: undefined });
    expect((await post("/api/claim/xlm", { address: Keypair.random().publicKey() })).status).toBe(200);
  });
});

describe("request hygiene", () => {
  it("rejects non-JSON content type with 415 (blocks simple cross-site form posts)", async () => {
    const r = await post(
      "/api/claim/g402t",
      `address=${Keypair.random().publicKey()}`,
      "1.1.1.1",
      "application/x-www-form-urlencoded",
    );
    expect(r.status).toBe(415);
    expect(world.calls).toHaveLength(0);
  });

  it("rejects malformed JSON and non-object JSON with 400", async () => {
    expect((await post("/api/claim/g402t", "{not json")).status).toBe(400);
    expect((await post("/api/claim/g402t", "[1,2]")).status).toBe(400);
    expect((await post("/api/claim/g402t", '"G"')).status).toBe(400);
  });

  it("rejects bodies over 2 KB with 413", async () => {
    const r = await post("/api/claim/g402t", { address: Keypair.random().publicKey(), pad: "x".repeat(4096) });
    expect(r.status).toBe(413);
    expect(world.calls).toHaveLength(0);
  });

  it("GET on a claim route is 405, unknown API route is 404", async () => {
    expect((await faucet.handle(new Request("https://faucet.test/api/claim/g402t"))).status).toBe(405);
    expect((await faucet.handle(new Request("https://faucet.test/api/claim/usdc", { method: "POST" }))).status).toBe(
      404,
    );
  });

  it("API responses are not cacheable", async () => {
    const res = await faucet.handle(new Request("https://faucet.test/api/info"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("S3: the distributor secret never leaves the server", () => {
  it("no response body or log line in this suite contains the secret", async () => {
    // Drive a mix of paths so the logs are populated, then scan everything captured.
    const user = Keypair.random().publicKey();
    world.withTrustline(user);
    await post("/api/claim/g402t", { address: user });
    world.submitResponses.push({ status: 400, body: { extras: { result_codes: { transaction: "tx_failed" } } } });
    const other = Keypair.random().publicKey();
    world.withTrustline(other);
    await post("/api/claim/g402t", { address: other }, "4.4.4.4");
    expect(world.logs.length).toBeGreaterThan(0);
    const all = [...responses, ...world.logs].join("\n");
    expect(all).not.toContain(distributor.secret());
    expect(all).not.toMatch(/\bS[A-Z2-7]{55}\b/);
  });
});
