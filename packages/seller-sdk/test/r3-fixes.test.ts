import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SqlitePendingStore, createPaywall, encodeHeader, splitCredentials, type HandleResult } from "../src/index.js";

const SELLER = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";
const TX = "cd".repeat(32);
const resource = { url: "https://seller.example/weather", mimeType: "application/json" };

/** Facilitator double with claim semantics; `fault` controls the /settle answer the seller sees. */
function facDouble() {
  const claims = new Map<string, { claimKey: string; status: "confirmed" | "submitted" }>();
  const calls: Array<{ path: string; key: string | null; auth: string | null; status: number }> = [];
  let fault: "none" | "502-after" | "502-before" | "429" | "401" = "none";
  let confirmOnSubmit = true;
  let chain: "SUCCESS" | "UNKNOWN" = "UNKNOWN";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const key = new Headers(init?.headers).get("idempotency-key");
    const auth = new Headers(init?.headers).get("authorization");
    const body = init?.body ? (JSON.parse(String(init.body)) as { paymentPayload: { payload: { transaction: string } } }) : undefined;
    const nonce = body?.paymentPayload.payload.transaction ?? "";
    const reply = (res: Response) => {
      calls.push({ path, key, auth, status: res.status });
      return res;
    };
    if (path === "/verify") {
      return reply(Response.json(claims.has(nonce) ? { isValid: false, invalidReason: "invalid_exact_stellar_payload_nonce_reused" } : { isValid: true, payer: "GPAYER" }));
    }
    if (path === "/settle") {
      if (fault === "502-before") return reply(new Response("bad", { status: 502 }));
      if (fault === "429") return reply(Response.json({ success: false, errorReason: "fee_budget_exhausted", transaction: "", network: "stellar:testnet" }, { status: 429 }));
      if (fault === "401") return reply(Response.json({ error: "unauthorized" }, { status: 401 }));
      const rec = claims.get(nonce);
      let res;
      if (!rec) {
        claims.set(nonce, { claimKey: key ?? "", status: confirmOnSubmit ? "confirmed" : "submitted" });
        res = confirmOnSubmit
          ? { success: true, transaction: TX, network: "stellar:testnet", payer: "GPAYER" }
          : { success: false, errorReason: "settle_exact_stellar_transaction_not_confirmed", transaction: TX, network: "stellar:testnet" };
      } else if (key && rec.claimKey === key) {
        res =
          rec.status === "confirmed" || chain === "SUCCESS"
            ? { success: true, transaction: TX, network: "stellar:testnet", payer: "GPAYER" }
            : { success: false, errorReason: "settle_exact_stellar_transaction_not_confirmed", transaction: TX, network: "stellar:testnet" };
      } else {
        res = { success: false, errorReason: "invalid_exact_stellar_payload_nonce_reused", transaction: TX, network: "stellar:testnet" };
      }
      if (fault === "502-after") return reply(new Response("bad", { status: 502 }));
      return reply(Response.json(res));
    }
    return reply(new Response("", { status: 404 }));
  };
  const mk = (extra: Partial<Parameters<typeof createPaywall>[0]> = {}) =>
    createPaywall({
      facilitatorUrl: "http://fac.local",
      payTo: SELLER,
      network: "stellar:testnet",
      fetch: fetchImpl,
      confirm: async () => chain,
      confirmAttempts: 1,
      confirmDelayMs: 1,
      ...extra,
    });
  return { mk, calls, setFault: (f: typeof fault) => (fault = f), setChain: (c: typeof chain) => (chain = c), setConfirmOnSubmit: (v: boolean) => (confirmOnSubmit = v) };
}

const header = (pw: ReturnType<typeof createPaywall>, tx = "AAAA") =>
  encodeHeader({ x402Version: 2, resource, accepted: pw.requirements("0.01"), payload: { transaction: tx } });
const call = (pw: ReturnType<typeof createPaywall>, h: string): Promise<HandleResult> =>
  pw.handle({ price: "0.01", resource, headers: new Headers({ "PAYMENT-SIGNATURE": h }) });
const code = (r: HandleResult) => (r.kind === "paid" ? 200 : r.status);
const err = (r: HandleResult) => (r.kind === "payment_required" ? r.body.error : r.kind);

describe("I-2r3 the SDK speaks bearer", () => {
  it("facilitatorToken -> Authorization: Bearer", async () => {
    const { mk, calls } = facDouble();
    const pw = mk({ facilitatorToken: " tokA_0123456789 " });
    expect(code(await call(pw, header(pw)))).toBe(200);
    expect(calls.every((c) => c.auth === "Bearer tokA_0123456789")).toBe(true);
  });
  it("URL forms: TOKEN@, :TOKEN@, bearer:TOKEN@ are bearer; user:pass is Basic only when explicitly a pair", () => {
    expect(splitCredentials("http://tok123@fac.local").authorization).toBe("Bearer tok123");
    expect(splitCredentials("http://:tok123@fac.local").authorization).toBe("Bearer tok123");
    expect(splitCredentials("http://bearer:tok123@fac.local").authorization).toBe("Bearer tok123");
    expect(splitCredentials("http://BEARER:tok123@fac.local/x402/").authorization).toBe("Bearer tok123");
    expect(splitCredentials("http://seller:s3cr3t@fac.local").authorization).toBe(`Basic ${Buffer.from("seller:s3cr3t").toString("base64")}`);
    expect(splitCredentials("http://fac.local").authorization).toBeUndefined();
    expect(splitCredentials("http://bearer:tok@fac.local/x402/").base).toBe("http://fac.local/x402");
  });
});

describe("M-r3-1 a definitive facilitator refusal is a 402, not a 409", () => {
  it.each([["429", "fee_budget_exhausted"], ["401", "unauthorized"]] as const)("facilitator %s -> 402 facilitator_refused, nothing pending", async (fault) => {
    const { mk, setFault, calls } = facDouble();
    const pw = mk();
    setFault(fault);
    const r = await call(pw, header(pw));
    expect(r.kind).toBe("payment_required");
    expect(err(r)).toBe("facilitator_refused");
    setFault("none");
    // No pending record: the next attempt is a fresh one (goes through /verify again).
    const before = calls.filter((c) => c.path === "/verify").length;
    expect(code(await call(pw, header(pw)))).toBe(200);
    expect(calls.filter((c) => c.path === "/verify").length).toBe(before + 1);
  });
});

describe("M-r3-2 tombstone after expiry", () => {
  it("an expired record keeps its claim key: a late landing is served through /settle with that key; otherwise 402 settlement_expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = 1_800_000_000_000;
      vi.setSystemTime(t0);
      const { mk, setConfirmOnSubmit, setChain, calls } = facDouble();
      setConfirmOnSubmit(false);
      const pw = mk();
      const h = header(pw);
      expect(code(await call(pw, h))).toBe(409);
      vi.setSystemTime(t0 + 150_000);
      const r2 = await call(pw, h);
      expect(err(r2)).toBe("settlement_expired");
      const keys = calls.filter((c) => c.path === "/settle").map((c) => c.key);
      expect(new Set(keys).size).toBe(1); // the retry re-asked with the same claim key
      setChain("SUCCESS"); // the envelope lands late
      const r3 = await call(pw, h);
      expect(code(r3)).toBe(200);
      expect(code(await call(pw, h))).toBe(402);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ruling: durable pendingStore survives a seller restart without relaxing C-1", () => {
  it("two seller instances sharing a SqlitePendingStore: the first loses the /settle answer, the second (restart) delivers once, the third attempt is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g402-pend-"));
    const store = new SqlitePendingStore(join(dir, "pending.sqlite"));
    const { mk, setFault } = facDouble();
    const first = mk({ pendingStore: store });
    const h = header(first);
    setFault("502-after");
    expect(code(await call(first, h))).toBe(409);
    setFault("none");
    const restarted = mk({ pendingStore: new SqlitePendingStore(join(dir, "pending.sqlite")) });
    expect(code(await call(restarted, h))).toBe(200);
    expect(code(await call(restarted, h))).toBe(402);
    expect(code(await call(first, h))).toBe(402);
  });

  it("a stranger instance with its own store cannot deliver the first seller's pending payment", async () => {
    const { mk, setFault } = facDouble();
    const first = mk();
    const h = header(first);
    setFault("502-after");
    expect(code(await call(first, h))).toBe(409);
    setFault("none");
    const stranger = mk();
    const r = await call(stranger, h);
    expect(err(r)).toBe("invalid_exact_stellar_payload_nonce_reused");
    expect(code(await call(first, h))).toBe(200);
  });

  it("SqlitePendingStore serializes concurrent work on one digest across two instances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g402-lock-"));
    const a = new SqlitePendingStore(join(dir, "p.sqlite"), { pollMs: 2 });
    const b = new SqlitePendingStore(join(dir, "p.sqlite"), { pollMs: 2 });
    const order: string[] = [];
    await Promise.all([
      a.withLock("d1", async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 40));
        order.push("a-end");
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 5));
        await b.withLock("d1", async () => {
          order.push("b");
        });
      })(),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
    await a.put({ digest: "d1", resourceKey: "k", method: "GET", requirements: first_req(), claimKey: "c", state: "pending", createdAt: 1, expiresAt: 2 });
    expect((await b.get("d1"))?.claimKey).toBe("c");
    await b.delete("d1");
    expect(await a.get("d1")).toBeUndefined();
  });
});

function first_req() {
  return createPaywall({ facilitatorUrl: "http://f", payTo: SELLER, network: "stellar:testnet" }).requirements("0.01");
}
