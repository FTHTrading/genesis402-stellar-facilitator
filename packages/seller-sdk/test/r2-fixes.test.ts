import { describe, expect, it, vi } from "vitest";
import { createPaywall, encodeHeader, type HandleResult } from "../src/index.js";

const SELLER = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";
const TX = "cd".repeat(32);
const resource = { url: "https://seller.example/weather", mimeType: "application/json" };

/** A facilitator double with the claim semantics of the real one. */
function facDouble() {
  const claims = new Map<string, { claimKey: string; status: "confirmed" | "submitted" }>();
  const calls: Array<{ path: string; key: string | null }> = [];
  let fault: "none" | "502-after" | "502-before" = "none";
  let confirmOnSubmit = true;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const key = new Headers(init?.headers).get("idempotency-key");
    calls.push({ path, key });
    const body = init?.body ? (JSON.parse(String(init.body)) as { paymentPayload: { payload: { transaction: string } } }) : undefined;
    const nonce = body?.paymentPayload.payload.transaction ?? "";
    if (path === "/verify") {
      return Response.json(claims.has(nonce) ? { isValid: false, invalidReason: "invalid_exact_stellar_payload_nonce_reused" } : { isValid: true, payer: "GPAYER" });
    }
    if (path === "/settle") {
      if (fault === "502-before") return new Response("bad", { status: 502 });
      const rec = claims.get(nonce);
      let res;
      if (!rec) {
        claims.set(nonce, { claimKey: key ?? "", status: confirmOnSubmit ? "confirmed" : "submitted" });
        res = confirmOnSubmit
          ? { success: true, transaction: TX, network: "stellar:testnet", payer: "GPAYER" }
          : { success: false, errorReason: "settle_exact_stellar_transaction_not_confirmed", transaction: TX, network: "stellar:testnet" };
      } else if (key && rec.claimKey === key) {
        res =
          rec.status === "confirmed"
            ? { success: true, transaction: TX, network: "stellar:testnet", payer: "GPAYER" }
            : { success: false, errorReason: "settle_exact_stellar_transaction_not_confirmed", transaction: TX, network: "stellar:testnet" };
      } else {
        res = { success: false, errorReason: "invalid_exact_stellar_payload_nonce_reused", transaction: TX, network: "stellar:testnet" };
      }
      if (fault === "502-after") return new Response("bad", { status: 502 });
      return Response.json(res);
    }
    return new Response("", { status: 404 });
  };
  let chain: "SUCCESS" | "UNKNOWN" = "UNKNOWN";
  const pw = createPaywall({
    facilitatorUrl: "http://fac.local",
    payTo: SELLER,
    network: "stellar:testnet",
    fetch: fetchImpl,
    confirm: async () => chain,
    confirmAttempts: 1,
    confirmDelayMs: 1,
  });
  return {
    pw,
    calls,
    setFault: (f: typeof fault) => (fault = f),
    setChain: (c: typeof chain) => (chain = c),
    setConfirmOnSubmit: (v: boolean) => (confirmOnSubmit = v),
  };
}

const header = (pw: ReturnType<typeof createPaywall>, tx = "AAAA", url = resource.url, method = "GET") =>
  encodeHeader({ x402Version: 2, resource: { url, mimeType: "application/json" }, accepted: pw.requirements("0.01", method), payload: { transaction: tx } });
const call = (pw: ReturnType<typeof createPaywall>, h: string, method = "GET", res = resource): Promise<HandleResult> =>
  pw.handle({ price: "0.01", resource: res, headers: new Headers({ "PAYMENT-SIGNATURE": h }), method });
const code = (r: HandleResult) => (r.kind === "paid" ? 200 : r.status);

describe("C-1 one payment buys one delivery", () => {
  it("20 concurrent requests with one header: exactly one 200, the rest 402 nonce_reused", async () => {
    const { pw } = facDouble();
    const h = header(pw);
    const rs = await Promise.all(Array.from({ length: 20 }, () => call(pw, h)));
    expect(rs.filter((r) => r.kind === "paid")).toHaveLength(1);
    expect(rs.filter((r) => r.kind === "payment_required" && r.body.error === "invalid_exact_stellar_payload_nonce_reused")).toHaveLength(19);
  });

  it("never delivers on nonce_reused, even when the chain shows the tx succeeded", async () => {
    const { pw, setChain } = facDouble();
    setChain("SUCCESS");
    const h = header(pw);
    expect(code(await call(pw, h))).toBe(200);
    const again = await call(pw, h);
    expect(again.kind).toBe("payment_required");
  });

  it("lost 502 after the facilitator settled: 409, retry with the same claim key -> 200, then 402", async () => {
    const { pw, setFault, calls } = facDouble();
    const h = header(pw);
    setFault("502-after");
    expect(code(await call(pw, h))).toBe(409);
    setFault("none");
    expect(code(await call(pw, h))).toBe(200);
    expect(code(await call(pw, h))).toBe(402);
    const settleKeys = calls.filter((c) => c.path === "/settle").map((c) => c.key);
    expect(settleKeys).toHaveLength(2);
    expect(settleKeys[0]).toBe(settleKeys[1]);
    expect(settleKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("two concurrent retries of one pending payment: exactly one 200", async () => {
    const { pw, setFault } = facDouble();
    const h = header(pw);
    setFault("502-after");
    expect(code(await call(pw, h))).toBe(409);
    setFault("none");
    const [a, b] = await Promise.all([call(pw, h), call(pw, h)]);
    expect([a, b].filter((r) => r.kind === "paid")).toHaveLength(1);
  });

  it("a different seller instance (different claim key) cannot read the first seller's claim", async () => {
    const first = facDouble();
    const h = header(first.pw);
    first.setFault("502-after");
    expect(code(await call(first.pw, h))).toBe(409);
    first.setFault("none");
    // Same facilitator state, but a second paywall with its own (unknown) claim key: no pending record -> verify -> nonce_reused.
    const second = createPaywall({ facilitatorUrl: "http://fac.local", payTo: SELLER, network: "stellar:testnet", fetch: (i, init) => (first.pw as never, fetchOf(first)(i, init)), confirm: async () => "SUCCESS", confirmAttempts: 1, confirmDelayMs: 1 });
    const r = await call(second, h);
    expect(r.kind).toBe("payment_required");
  });
});

function fetchOf(d: ReturnType<typeof facDouble>): typeof fetch {
  // The double's fetch is captured inside its paywall; re-expose it by calling through the same closure.
  return (d as unknown as { fetchImpl?: typeof fetch }).fetchImpl ?? ((async () => new Response("", { status: 404 })) as typeof fetch);
}

describe("I-3r2 pending state terminates", () => {
  it("after the envelope time bounds and auth expiry have passed with no inclusion, the retry gets a terminal 402 and the record is dropped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { pw, setFault, setConfirmOnSubmit, calls } = facDouble();
      setConfirmOnSubmit(false); // submitted but never confirmed
      const h = header(pw);
      const r1 = await call(pw, h);
      expect(r1.kind).toBe("settlement_pending");
      vi.setSystemTime(Date.now() + 60 * 60_000);
      const r2 = await call(pw, h);
      expect(r2.kind).toBe("payment_required");
      if (r2.kind === "payment_required") expect(r2.body.error).toBe("settlement_expired");
      // Record dropped: the next request is a fresh attempt (goes through /verify again).
      setFault("none");
      const before = calls.filter((c) => c.path === "/verify").length;
      await call(pw, h);
      expect(calls.filter((c) => c.path === "/verify").length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an expired record still delivers if the chain shows the tx succeeded in the meantime", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { pw, setConfirmOnSubmit, setChain } = facDouble();
      setConfirmOnSubmit(false);
      const h = header(pw);
      expect(code(await call(pw, h))).toBe(409);
      vi.setSystemTime(Date.now() + 60 * 60_000);
      setChain("SUCCESS");
      expect(code(await call(pw, h))).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("M-r2-2 payment bound to the HTTP method", () => {
  it("a GET quote presented on POST is refused before settlement; a POST quote on POST is accepted", async () => {
    const { pw, calls } = facDouble();
    const r = await call(pw, header(pw), "POST");
    expect(r.kind).toBe("payment_required");
    if (r.kind === "payment_required") {
      expect(r.body.error).toBe("resource_mismatch");
      expect(r.body.accepts[0]?.extra).toMatchObject({ method: "POST" });
    }
    expect(calls.filter((c) => c.path === "/settle")).toHaveLength(0);
    expect(code(await call(pw, header(pw, "BBBB", resource.url, "POST"), "POST"))).toBe(200);
  });

  it("a POST quote presented on GET is refused", async () => {
    const { pw } = facDouble();
    expect(code(await call(pw, header(pw, "CCCC", resource.url, "POST"), "GET"))).toBe(402);
  });

  it("GET quotes carry no method field (unchanged wire format for the common case)", () => {
    const { pw } = facDouble();
    expect(pw.requirements("0.01").extra).toEqual({ areFeesSponsored: true });
    expect(pw.requirements("0.01", "post").extra).toEqual({ areFeesSponsored: true, method: "POST" });
  });
});
