// Phase 4 review: attacks on S1-S4 and XSS/CSP that are EXPECTED TO HOLD.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Asset, Keypair, StrKey, type Operation } from "@stellar/stellar-sdk/base";
import { beforeEach, describe, expect, it } from "vitest";
import { addr, call, config, distributor, issuer, makeFaucet, World } from "./harness.js";

const root = fileURLToPath(new URL("..", import.meta.url));
let world: World;
let clock: { t: number };
let faucet: ReturnType<typeof makeFaucet>;
beforeEach(() => {
  world = new World();
  clock = { t: 1_800_000_000_000 };
  faucet = makeFaucet(world, clock);
});

const H = (ip: string, extra: Record<string, string> = {}) => ({ "content-type": "application/json", "cf-connecting-ip": ip, ...extra });

function assertOnlyFixedPayment(to: string) {
  expect(world.submitted).toHaveLength(1);
  const tx = world.submitted[0]!;
  expect(tx.source).toBe(distributor.publicKey());
  expect(tx.operations).toHaveLength(1);
  const op = tx.operations[0] as Operation.Payment;
  expect(op.type).toBe("payment");
  expect(op.source).toBeUndefined();
  expect(op.destination).toBe(to);
  expect(op.amount).toBe("1000.0000000");
  expect((op.asset as Asset).equals(new Asset("G402T", issuer.publicKey()))).toBe(true);
}

describe("S1 tampering cannot change asset/amount/destination/source", () => {
  it("extra top-level fields, nested objects, __proto__ and constructor are ignored", async () => {
    const a = addr();
    const evil = addr();
    const body =
      `{"address":"${a}","amount":"999999999","asset":"native","asset_code":"XLM","source":"${evil}",` +
      `"destination":"${evil}","to":"${evil}","__proto__":{"amount":"5"},"constructor":{"prototype":{"amount":"7"}},"op":{"type":"setOptions"}}`;
    const r = await call(faucet, "/api/claim/g402t", body);
    expect(r.status).toBe(200);
    assertOnlyFixedPayment(a);
  });

  it("duplicate address key: last one wins and it is the one paid AND rate-limited", async () => {
    const a = addr();
    const b = addr();
    const r = await call(faucet, "/api/claim/g402t", `{"address":"${a}","address":"${b}"}`);
    expect(r.status).toBe(200);
    assertOnlyFixedPayment(b);
    const again = await call(faucet, "/api/claim/g402t", JSON.stringify({ address: b }), H("198.51.100.9"));
    expect(again.status).toBe(429);
  });

  it("arrays, numbers, null, nested address are rejected with no outbound call", async () => {
    const a = addr();
    for (const body of [
      JSON.stringify([{ address: a }]),
      JSON.stringify({ address: [a] }),
      JSON.stringify({ address: [a, addr()] }),
      JSON.stringify({ address: { toString: a } }),
      JSON.stringify({ address: 12345 }),
      JSON.stringify({ address: null }),
      JSON.stringify({ addr: a }),
      "null",
      `"${a}"`,
    ]) {
      const r = await call(faucet, "/api/claim/g402t", body);
      expect(r.status, body).toBe(400);
    }
    expect(world.calls).toHaveLength(0);
  });

  it("unicode tricks (zero-width, fullwidth, homoglyph, RTL override, NUL, lowercase, two addresses) are rejected offline", async () => {
    const a = addr();
    const variants = [
      `${a.slice(0, 10)}​${a.slice(10)}`,
      a.replace(/^G/, "Ｇ"),
      a.replace(/^G/, "ɢ"),
      `‮${a}`,
      `${a}\u0000`,
      a.toLowerCase(),
      `${a} ${addr()}`,
      `${a}\n${addr()}`,
    ];
    for (const v of variants) {
      const r = await call(faucet, "/api/claim/g402t", JSON.stringify({ address: v }));
      expect(r.status, JSON.stringify(v)).toBe(400);
    }
    expect(world.calls).toHaveLength(0);
  });

  it("wrong content types are 415 with no outbound call", async () => {
    const body = JSON.stringify({ address: addr() });
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "", "text/json", "application/jsonx"]) {
      const h: Record<string, string> = { "cf-connecting-ip": "203.0.113.7" };
      if (ct) h["content-type"] = ct;
      const r = await call(faucet, "/api/claim/g402t", body, h);
      expect(r.status, ct).toBe(415);
    }
    expect(world.calls).toHaveLength(0);
  });

  it("body just over 2 KB (padding fields) is 413", async () => {
    const r = await call(faucet, "/api/claim/g402t", JSON.stringify({ address: addr(), pad: "x".repeat(2100) }));
    expect(r.status).toBe(413);
    expect(world.calls).toHaveLength(0);
  });

  it("query params amount/asset/address/destination are ignored", async () => {
    const a = addr();
    const res = await faucet.handle(
      new Request(`https://faucet.review/api/claim/g402t?amount=99999&asset=native&address=${addr()}&destination=${addr()}&source=${addr()}`, {
        method: "POST",
        headers: H("203.0.113.7"),
        body: JSON.stringify({ address: a }),
      }),
    );
    expect(res.status).toBe(200);
    assertOnlyFixedPayment(a);
  });

  it("method override headers and path tricks do not reach another handler", async () => {
    const body = JSON.stringify({ address: addr() });
    const h = H("203.0.113.7", { "x-http-method-override": "POST" });
    expect((await call(faucet, "/api/claim/g402t/", body, h)).status).toBe(404);
    expect((await call(faucet, "/api/claim/G402T", body, h)).status).toBe(404);
    expect((await call(faucet, "/api/claim/g402t", null, h, "GET")).status).toBe(405);
    expect(world.calls).toHaveLength(0);
  });
});

describe("S2 rate limit under concurrency", () => {
  it("25 parallel claims, same address, 25 different IPs: exactly one payment", async () => {
    const a = addr();
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => call(faucet, "/api/claim/g402t", JSON.stringify({ address: a }), H(`198.51.100.${i + 1}`))));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(24);
    expect(world.submitted).toHaveLength(1);
  });

  it("25 parallel claims, same IP, 25 addresses: exactly one payment", async () => {
    const rs = await Promise.all(Array.from({ length: 25 }, () => call(faucet, "/api/claim/g402t", JSON.stringify({ address: addr() }))));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(world.submitted).toHaveLength(1);
  });

  it("25 parallel XLM claims same IP: exactly one Friendbot call", async () => {
    await Promise.all(Array.from({ length: 25 }, () => call(faucet, "/api/claim/xlm", JSON.stringify({ address: addr() }))));
    expect(world.calls.filter((c) => c.url.startsWith("https://friendbot"))).toHaveLength(1);
  });

  it("a rejected send (tx_failed) returns the slot: the next claim pays", async () => {
    const a = addr();
    world.submitResponses.push({ status: 400, body: { extras: { result_codes: { transaction: "tx_failed", operations: ["op_underfunded"] } } } });
    expect((await call(faucet, "/api/claim/g402t", JSON.stringify({ address: a }))).status).toBe(502);
    expect((await call(faucet, "/api/claim/g402t", JSON.stringify({ address: a }))).status).toBe(200);
    expect(world.submitted).toHaveLength(1);
  });

  it("an unknown outcome (504) keeps the slot: the next claim is refused", async () => {
    const a = addr();
    world.submitResponses.push({ status: 504, body: { title: "Timeout" } });
    expect((await call(faucet, "/api/claim/g402t", JSON.stringify({ address: a }))).status).toBe(504);
    const again = await call(faucet, "/api/claim/g402t", JSON.stringify({ address: a }), H("192.0.2.50"));
    expect(again.status).toBe(429);
  });

  it("X-Forwarded-For / X-Real-IP / True-Client-IP / Forwarded are ignored; only CF-Connecting-IP keys the IP limit", async () => {
    const spoof = (s: string) => H("203.0.113.7", { "x-forwarded-for": s, "x-real-ip": s, "true-client-ip": s, forwarded: "for=" + s });
    expect((await call(faucet, "/api/claim/g402t", JSON.stringify({ address: addr() }), spoof("1.1.1.1"))).status).toBe(200);
    expect((await call(faucet, "/api/claim/g402t", JSON.stringify({ address: addr() }), spoof("9.9.9.9"))).status).toBe(429);
  });

  it("no CF-Connecting-IP header: all such callers share one 'unknown' bucket (fails closed, not open)", async () => {
    const h = (x: string) => ({ "content-type": "application/json", "x-forwarded-for": x });
    expect((await call(faucet, "/api/claim/g402t", JSON.stringify({ address: addr() }), h("1.1.1.1"))).status).toBe(200);
    expect((await call(faucet, "/api/claim/g402t", JSON.stringify({ address: addr() }), h("2.2.2.2"))).status).toBe(429);
  });
});

describe("S3 secret never reachable", () => {
  it("forced Horizon/Friendbot errors whose bodies or exceptions carry the secret never surface it in responses or logs", async () => {
    const secret = distributor.secret();
    const outputs: string[] = [];
    world.accountResponse = () => new Response(`{"detail":"DISTRIBUTOR_SECRET=${secret}"}`, { status: 500 });
    outputs.push((await call(faucet, "/api/claim/g402t", JSON.stringify({ address: addr() }), H("10.0.0.1"))).text);
    world.accountResponse = () => {
      throw new Error(`boom ${secret}`);
    };
    outputs.push((await call(faucet, "/api/claim/g402t", JSON.stringify({ address: addr() }), H("10.0.0.2"))).text);
    world.accountResponse = () => new Response("not json at all " + secret, { status: 200 });
    outputs.push((await call(faucet, "/api/claim/g402t", JSON.stringify({ address: addr() }), H("10.0.0.3"))).text);
    world.accountResponse = null;
    world.submitResponses.push({ status: 400, body: { extras: { result_codes: { transaction: "tx_bad_auth" }, envelope_xdr: "AAAA" } } });
    outputs.push((await call(faucet, "/api/claim/g402t", JSON.stringify({ address: addr() }), H("10.0.0.4"))).text);
    world.friendbot = { status: 500, body: { detail: secret } };
    outputs.push((await call(faucet, "/api/claim/xlm", JSON.stringify({ address: addr() }), H("10.0.0.5"))).text);
    outputs.push((await call(faucet, "/api/info", null, {}, "GET")).text);
    outputs.push((await call(faucet, "/api/nope", null, {}, "GET")).text);
    const all = outputs.join("\n") + "\n" + world.logs.join("\n");
    expect(all).not.toContain(secret);
    expect(all).not.toContain("DISTRIBUTOR_SECRET");
    expect(all).not.toMatch(/\bS[A-Z2-7]{55}\b/);
    expect(all).not.toMatch(/envelope_xdr/);
  });

  it("a mismatched secret is not echoed and the log line names no key", async () => {
    const wrong = Keypair.random().secret();
    const f = makeFaucet(world, clock, { secret: wrong });
    const r = await call(f, "/api/claim/g402t", JSON.stringify({ address: addr() }));
    expect(r.status).toBe(503);
    expect(r.text + world.logs.join("\n")).not.toContain(wrong);
  });
});

describe("S4 address validation happens before any network call", () => {
  it("M, C, S, junk, checksum-flipped and truncated addresses are 400 on both endpoints with zero outbound calls", async () => {
    const g = addr();
    const flipped = g.slice(0, 55) + (g[55] === "A" ? "B" : "A");
    const mid = g.slice(0, 20) + (g[20] === "A" ? "B" : "A") + g.slice(21);
    const bad = [
      StrKey.encodeMed25519PublicKey(Buffer.concat([StrKey.decodeEd25519PublicKey(g), Buffer.alloc(8, 1)])),
      config.usdc.sac,
      Keypair.random().secret(),
      flipped,
      mid,
      g.slice(0, 55),
      g + "A",
      "GAAAA",
      "x".repeat(128),
      "x".repeat(1900),
      "../../accounts/" + g,
      g.replace(/^G/, "T"),
    ];
    for (const path of ["/api/claim/g402t", "/api/claim/xlm"]) {
      for (const v of bad) {
        const r = await call(faucet, path, JSON.stringify({ address: v }));
        expect(r.status, `${path} ${v.slice(0, 20)}`).toBe(400);
      }
    }
    expect(world.calls).toHaveLength(0);
  });
});

describe("XSS / CSP", () => {
  it("client never writes HTML from strings; CSP has no unsafe-inline/eval and frames denied", () => {
    const client = readFileSync(join(root, "src", "client", "main.ts"), "utf8");
    expect(client).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    const headers = readFileSync(join(root, "public", "_headers"), "utf8");
    const csp = headers.split("\n").find((l) => /content-security-policy/i.test(l)) ?? "";
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/script-src 'self';/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\s\*/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    const html = readFileSync(join(root, "public", "index.html"), "utf8");
    expect(html).not.toMatch(/<script>/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/style="/);
  });

  it("an address carrying markup never reaches a response (rejected before reflection)", async () => {
    const r = await call(faucet, "/api/claim/g402t", JSON.stringify({ address: "<img src=x onerror=alert(1)>" }));
    expect(r.status).toBe(400);
    expect(r.text).not.toContain("<img");
  });
});
