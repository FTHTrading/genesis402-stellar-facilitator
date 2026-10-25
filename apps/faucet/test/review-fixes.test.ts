// Tests added for review findings I-1..I-3, M-1..M-5 (review of 6ef2673).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, Networks, StrKey, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk/base";
import { beforeEach, describe, expect, it } from "vitest";
import { createFaucet, type FaucetConfig } from "../src/faucet.js";
import { MSG } from "../src/messages.js";
import { ClaimLimiter, ipBucket, type LimiterOptions } from "../src/ratelimit.js";
import { sqliteD1 } from "./sqlite-d1.js";

const root = fileURLToPath(new URL("..", import.meta.url).href);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const HORIZON = "https://horizon.fix";
const FRIENDBOT = "https://friendbot.fix";
const issuer = Keypair.random();
const distributor = Keypair.random();

const config: FaucetConfig = {
  networkPassphrase: Networks.TESTNET,
  horizonUrl: HORIZON,
  friendbotUrl: FRIENDBOT,
  explorerTxBase: "https://stellar.expert/explorer/testnet/tx/",
  asset: { code: "G402T", issuer: issuer.publicKey(), sac: StrKey.encodeContract(Buffer.alloc(32, 1)) },
  distributor: distributor.publicKey(),
  xlmSac: StrKey.encodeContract(Buffer.alloc(32, 2)),
  usdc: { sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", faucetUrl: "https://faucet.circle.com" },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Every account exists with a G402T trustline. Submits and tx lookups are scriptable. */
class World {
  calls: Array<{ method: string; url: string }> = [];
  logs: string[] = [];
  submitted: Transaction[] = [];
  submitResponses: Array<{ status: number; body: unknown } | "network-error"> = [];
  /** Answer for GET /transactions/<hash>. null = 404. "network-error" = throw. */
  lookup: ((hash: string) => { status: number; body: unknown } | "network-error") | null = null;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    this.calls.push({ method, url });
    if (url.startsWith(FRIENDBOT)) return json({ hash: "f".repeat(64) });
    if (url.startsWith(`${HORIZON}/accounts/`)) {
      const id = decodeURIComponent(url.slice(`${HORIZON}/accounts/`.length));
      return json({
        id,
        sequence: "100",
        balances: [
          { asset_type: "native", balance: "10000.0000000" },
          {
            asset_type: "credit_alphanum12",
            asset_code: "G402T",
            asset_issuer: issuer.publicKey(),
            balance: id === distributor.publicKey() ? "1000000000.0000000" : "0.0000000",
            limit: "922337203685.4775807",
          },
        ],
      });
    }
    if (url === `${HORIZON}/transactions` && method === "POST") {
      const xdr = new URLSearchParams(String(init?.body ?? "")).get("tx") ?? "";
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
      this.submitted.push(tx);
      const next = this.submitResponses.shift();
      if (next === "network-error") throw new TypeError("fetch failed");
      if (next) return json(next.body, next.status);
      return json({ hash: Buffer.from(tx.hash()).toString("hex") });
    }
    if (url.startsWith(`${HORIZON}/transactions/`) && method === "GET") {
      const hash = url.slice(`${HORIZON}/transactions/`.length);
      const r = this.lookup ? this.lookup(hash) : { status: 404, body: { title: "Resource Missing" } };
      if (r === "network-error") throw new TypeError("fetch failed");
      return json(r.body, r.status);
    }
    return json({ error: "unexpected" }, 599);
  };
}

let world: World;
let clock: { t: number };

function build(opts: Partial<LimiterOptions> = {}) {
  const limiter = new ClaimLimiter(sqliteD1(), { windowMs: DAY, perAddress: 1, perIp: 1, ...opts });
  return createFaucet({
    config,
    limiter,
    fetch: world.fetch as typeof fetch,
    distributorSecret: distributor.secret(),
    now: () => clock.t,
    log: (l) => world.logs.push(l),
  });
}

async function post(f: ReturnType<typeof build>, path: string, address: string, ip = "203.0.113.7") {
  const res = await f.handle(
    new Request(`https://faucet.fix${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ address }),
    }),
  );
  return { status: res.status, headers: res.headers, body: JSON.parse(await res.text()) as Record<string, any> };
}

const addr = () => Keypair.random().publicKey();

beforeEach(() => {
  world = new World();
  clock = { t: Date.UTC(2027, 0, 15, 12, 0, 0) };
});

describe("I-1 ipBucket", () => {
  it("IPv4 stays the full address", () => {
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket(" 203.0.113.7 ")).toBe("203.0.113.7");
  });

  it("IPv6 is cut to its /64, whatever the spelling", () => {
    const want = "2001:db8:1234:5678::/64";
    expect(ipBucket("2001:db8:1234:5678::1")).toBe(want);
    expect(ipBucket("2001:0DB8:1234:5678:ffff:eeee:dddd:cccc")).toBe(want);
    expect(ipBucket("2001:db8:1234:5678:0:0:0:abcd")).toBe(want);
    expect(ipBucket("2001:db8:1234:5679::1")).toBe("2001:db8:1234:5679::/64");
    expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
    expect(ipBucket("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("IPv4-mapped IPv6 is treated as the IPv4 address", () => {
    expect(ipBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("anything unparseable is kept as-is (still a bucket of its own)", () => {
    expect(ipBucket("unknown")).toBe("unknown");
    expect(ipBucket("1:2:3")).toBe("1:2:3");
  });

  it("two hosts in one /64 share the per-IP slot; a different /64 does not", async () => {
    const l = new ClaimLimiter(sqliteD1(), { windowMs: DAY, perAddress: 1, perIp: 1 });
    expect((await l.reserve("g402t", "GA", "2001:db8:1:2::a", 1000)).ok).toBe(true);
    const same = await l.reserve("g402t", "GB", "2001:db8:1:2::b", 1000);
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.scope).toBe("ip");
    expect((await l.reserve("g402t", "GC", "2001:db8:1:3::a", 1000)).ok).toBe(true);
  });
});

describe("I-2 global daily cap", () => {
  it("defaults to 1,000 G402T claims per UTC day, then refuses with scope global until UTC midnight", async () => {
    const l = new ClaimLimiter(sqliteD1(), { windowMs: DAY, perAddress: 1, perIp: 1 });
    const now = Date.UTC(2027, 0, 15, 23, 0, 0);
    for (let i = 0; i < 1000; i++) {
      expect((await l.reserve("g402t", `G${i}`, `10.0.${i >> 8}.${i & 255}`, now)).ok).toBe(true);
    }
    const over = await l.reserve("g402t", "GX", "10.9.9.9", now);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.scope).toBe("global");
      expect(over.retryAfterSec).toBe(3600);
    }
    // The refused address and IP were handed back: they can claim on the next UTC day.
    expect((await l.reserve("g402t", "GX", "10.9.9.9", Date.UTC(2027, 0, 16, 0, 0, 0))).ok).toBe(true);
  });

  it("is configurable and only applies to G402T by default (XLM is capped by Friendbot)", async () => {
    const l = new ClaimLimiter(sqliteD1(), { windowMs: DAY, perAddress: 1, perIp: 1, globalPerDay: { g402t: 2 } });
    expect((await l.reserve("g402t", "GA", "1.1.1.1", 0)).ok).toBe(true);
    expect((await l.reserve("g402t", "GB", "1.1.1.2", 0)).ok).toBe(true);
    const r = await l.reserve("g402t", "GC", "1.1.1.3", 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.scope).toBe("global");
    for (let i = 0; i < 5; i++) expect((await l.reserve("xlm", `G${i}`, `2.2.2.${i}`, 0)).ok).toBe(true);
  });

  it("a released claim (nothing sent) gives the global slot back", async () => {
    const l = new ClaimLimiter(sqliteD1(), { windowMs: DAY, perAddress: 1, perIp: 1, globalPerDay: { g402t: 1 } });
    const r = await l.reserve("g402t", "GA", "1.1.1.1", 0);
    expect(r.ok).toBe(true);
    if (r.ok) await r.release();
    expect((await l.reserve("g402t", "GB", "1.1.1.2", 0)).ok).toBe(true);
  });

  it("the faucet answers 429 scope global with a clear message and Retry-After", async () => {
    const f = build({ globalPerDay: { g402t: 1 } });
    expect((await post(f, "/api/claim/g402t", addr(), "10.0.0.1")).status).toBe(200);
    const r = await post(f, "/api/claim/g402t", addr(), "10.0.0.2");
    expect(r.status).toBe(429);
    expect(r.body.scope).toBe("global");
    expect(r.body.message).toBe(MSG.rateLimited("1,000 G402T", "global", "12h"));
    expect(r.body.message).toMatch(/daily limit/i);
    expect(r.headers.get("retry-after")).toBe(String(12 * 3600));
    expect(world.submitted).toHaveLength(1);
  });

  it("globalLimitsFromEnv reads the env var and falls back to 1,000", async () => {
    const { globalLimitsFromEnv } = await import("../src/ratelimit.js");
    expect(globalLimitsFromEnv(undefined)).toEqual({ g402t: 1000 });
    expect(globalLimitsFromEnv("250")).toEqual({ g402t: 250 });
    expect(globalLimitsFromEnv("0")).toEqual({ g402t: 1000 });
    expect(globalLimitsFromEnv("abc")).toEqual({ g402t: 1000 });
  });
});

describe("I-3 submit outcomes", () => {
  for (const status of [429, 503]) {
    it(`Horizon ${status} on submit: 503 busy, nothing sent, slot released`, async () => {
      const f = build();
      const a = addr();
      world.submitResponses.push({ status, body: { status } });
      const r = await post(f, "/api/claim/g402t", a);
      expect(r.status).toBe(503);
      expect(r.body.error).toBe("horizon_busy");
      expect(r.body.message).toBe(MSG.horizonBusy);
      expect(r.body.message).toMatch(/busy, try again shortly/i);
      expect(r.body.message).not.toMatch(/was sent|may have been sent/i);
      expect(r.body.explorer).toBeUndefined();
      expect((await post(f, "/api/claim/g402t", a)).status).toBe(200);
    });
  }

  it("504: the transaction is looked up once; if Horizon has it, the claim is reported as paid", async () => {
    const f = build();
    world.submitResponses.push({ status: 504, body: { title: "Timeout" } });
    world.lookup = (hash) => ({ status: 200, body: { hash, successful: true } });
    const r = await post(f, "/api/claim/g402t", addr());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.explorer).toBe(`${config.explorerTxBase}${r.body.hash}`);
    const lookups = world.calls.filter((c) => c.method === "GET" && c.url.startsWith(`${HORIZON}/transactions/`));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.url).toBe(`${HORIZON}/transactions/${r.body.hash}`);
  });

  it("504 and the lookup finds nothing: 504 'may have been sent; check the link', slot kept", async () => {
    const f = build();
    const a = addr();
    world.submitResponses.push({ status: 504, body: { title: "Timeout" } });
    const r = await post(f, "/api/claim/g402t", a);
    expect(r.status).toBe(504);
    expect(r.body.error).toBe("submit_pending");
    expect(r.body.message).toBe(MSG.submitPending);
    expect(r.body.message).toMatch(/may have been sent/i);
    expect(r.body.message).toMatch(/check the (transaction )?link before trying again/i);
    expect(r.body.message).not.toMatch(/was sent/i);
    expect(r.body.explorer).toBe(`${config.explorerTxBase}${r.body.hash}`);
    expect(world.calls.filter((c) => c.method === "GET" && c.url.includes("/transactions/"))).toHaveLength(1);
    expect((await post(f, "/api/claim/g402t", a, "198.51.100.1")).status).toBe(429);
  });

  it("network error on submit, lookup also fails: 504 pending, slot kept", async () => {
    const f = build();
    const a = addr();
    world.submitResponses.push("network-error");
    world.lookup = () => "network-error";
    const r = await post(f, "/api/claim/g402t", a);
    expect(r.status).toBe(504);
    expect(r.body.error).toBe("submit_pending");
    expect((await post(f, "/api/claim/g402t", a, "198.51.100.1")).status).toBe(429);
  });

  it("504 and the lookup shows the transaction failed in the ledger: nothing sent, slot released", async () => {
    const f = build();
    const a = addr();
    world.submitResponses.push({ status: 504, body: { title: "Timeout" } });
    world.lookup = (hash) => ({ status: 200, body: { hash, successful: false } });
    const r = await post(f, "/api/claim/g402t", a);
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("submit_failed");
    expect((await post(f, "/api/claim/g402t", a)).status).toBe(200);
  });
});

describe("M-1 attempts per IP per hour are never handed back", () => {
  it("limiter: after 5 attempts in an hour the 6th is refused with scope attempts, even though each was released", async () => {
    const l = new ClaimLimiter(sqliteD1(), { windowMs: DAY, perAddress: 1, perIp: 1 });
    for (let i = 0; i < 5; i++) {
      const r = await l.reserve("xlm", `G${i}`, "9.9.9.9", 1000 + i);
      expect(r.ok).toBe(true);
      if (r.ok) await r.release();
    }
    const sixth = await l.reserve("xlm", "G6", "9.9.9.9", 2000);
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) {
      expect(sixth.scope).toBe("attempts");
      expect(sixth.retryAfterSec).toBe(Math.ceil((1000 + HOUR - 2000) / 1000));
    }
    // A refused attempt hands back the address/IP slots it took, so G6 is not burned.
    expect((await l.reserve("xlm", "G6", "8.8.8.8", 2000)).ok).toBe(true);
    // Per endpoint: G402T attempts are counted separately.
    expect((await l.reserve("g402t", "G7", "9.9.9.9", 2000)).ok).toBe(true);
    // The window is an hour.
    expect((await l.reserve("xlm", "G8", "9.9.9.9", 1000 + HOUR)).ok).toBe(true);
  });

  it("attempts are keyed on the IPv6 /64 too, and the per-hour limit is configurable", async () => {
    const l = new ClaimLimiter(sqliteD1(), { windowMs: DAY, perAddress: 1, perIp: 1, attemptsPerHour: 2 });
    for (let i = 0; i < 2; i++) {
      const r = await l.reserve("xlm", `G${i}`, `2001:db8:1:2::${i + 1}`, 0);
      expect(r.ok).toBe(true);
      if (r.ok) await r.release();
    }
    const r = await l.reserve("xlm", "G9", "2001:db8:1:2::99", 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.scope).toBe("attempts");
  });

  it("the faucet answers 429 scope attempts with a clear message", async () => {
    const f = build({ attemptsPerHour: 1 });
    world.submitResponses.push({ status: 400, body: { extras: { result_codes: { transaction: "tx_failed" } } } });
    expect((await post(f, "/api/claim/g402t", addr())).status).toBe(502);
    const r = await post(f, "/api/claim/g402t", addr());
    expect(r.status).toBe(429);
    expect(r.body.scope).toBe("attempts");
    expect(r.body.message).toMatch(/too many tries/i);
  });
});

describe("M-2 body is checked before it is read", () => {
  function streamed(bytes: number, headers: Record<string, string>) {
    let pulled = 0;
    const chunk = new Uint8Array(1024).fill(0x20);
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (pulled >= bytes) return ctrl.close();
        pulled += chunk.length;
        ctrl.enqueue(chunk);
      },
    });
    const req = new Request("https://faucet.fix/api/claim/g402t", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.5", ...headers },
      body,
      // @ts-expect-error node fetch needs duplex for stream bodies
      duplex: "half",
    });
    return { req, pulled: () => pulled };
  }

  it("a Content-Length over 2 KB is refused with 413 before any byte is read", async () => {
    const f = build();
    const s = streamed(1024 * 1024, { "content-length": String(1024 * 1024) });
    const res = await f.handle(s.req);
    expect(res.status).toBe(413);
    expect(s.pulled()).toBeLessThanOrEqual(2 * 1024);
    expect(world.calls).toHaveLength(0);
  });

  it("a streamed body with no Content-Length stops being read once it passes 2 KB", async () => {
    const f = build();
    const s = streamed(1024 * 1024, {});
    const res = await f.handle(s.req);
    expect(res.status).toBe(413);
    expect(s.pulled()).toBeLessThanOrEqual(8 * 1024);
  });

  it("a body of exactly 2 KB is still accepted", async () => {
    const f = build();
    const a = addr();
    const base = JSON.stringify({ address: a, pad: "" });
    const body = JSON.stringify({ address: a, pad: "x".repeat(2048 - base.length) });
    expect(new TextEncoder().encode(body).length).toBe(2048);
    const res = await f.handle(
      new Request("https://faucet.fix/api/claim/g402t", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.6" },
        body,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("an empty body is 400 bad_json", async () => {
    const f = build();
    const res = await f.handle(
      new Request("https://faucet.fix/api/claim/g402t", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.6" },
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("M-3 copy", () => {
  const html = () => readFileSync(join(root, "public", "index.html"), "utf8");
  it("calls G402T a test token, never a test dollar", () => {
    expect(html()).not.toMatch(/test dollar/i);
    expect(html()).toContain("G402T test token");
  });
  it("says No sign-up, without 'no accounts' (the page creates a Stellar account)", () => {
    expect(html()).not.toMatch(/no accounts/i);
    expect(html()).toContain("No sign-up.");
  });
});

describe("M-4 wallet flow keeps a funded wallet visible", () => {
  const client = () => readFileSync(join(root, "src", "client", "main.ts"), "utf8");

  it("the wallet card is built by one function used on success AND on a failure after funding", () => {
    const src = client();
    expect(src).toMatch(/function walletCard\(/);
    const uses = src.match(/walletCard\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3); // definition + success + failure path
    const catchBlock = src.slice(src.indexOf("} catch (err) {", src.indexOf("function setupWallet")));
    expect(catchBlock.slice(0, 1200)).toMatch(/if \(funded[^)]*\)[\s\S]*walletCard\(/);
  });

  it("the card always carries the testnet warning and the secret row", () => {
    const src = client();
    const fn = src.slice(src.indexOf("function walletCard("), src.indexOf("function walletCard(") + 1600);
    expect(fn).toContain("Testnet only. These tokens have no value.");
    expect(fn).toMatch(/copyRow\("Secret key"/);
  });

  it("after a successful run the button says 'Done — make another tomorrow' and is disabled", () => {
    const src = client();
    expect(src).toContain("Done — make another tomorrow");
    expect(src).toMatch(/btn\.disabled = true;\s*btn\.textContent = DONE_LABEL/);
    expect(src).not.toContain("Make me another test wallet");
  });
});

describe("M-5 DEPLOY.md testnet reset", () => {
  it("has a Testnet reset section with the recovery steps", () => {
    const doc = readFileSync(join(root, "DEPLOY.md"), "utf8");
    const i = doc.indexOf("## Testnet reset");
    expect(i).toBeGreaterThan(-1);
    const section = doc.slice(i, doc.indexOf("\n## ", i + 5) === -1 ? undefined : doc.indexOf("\n## ", i + 5));
    expect(section).toMatch(/resets periodically/i);
    expect(section).toContain("scripts/setup-testnet.ts");
    expect(section).toContain("testnet-asset.json");
    expect(section).toMatch(/issuer/i);
    expect(section).toMatch(/distributor/i);
    expect(section).toMatch(/SAC/);
    expect(section).toMatch(/wrangler secret bulk/);
    expect(section).toMatch(/wrangler deploy/);
  });
});
