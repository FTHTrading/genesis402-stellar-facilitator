import { describe, expect, it } from "vitest";
import { createPaywall, encodeHeader, resourceKey } from "../src/index.js";

const SELLER = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";
const TX = "cd".repeat(32);
const resource = { url: "https://seller.example/weather", mimeType: "application/json" };

function header(pw: ReturnType<typeof createPaywall>, res = resource) {
  return encodeHeader({ x402Version: 2, resource: res, accepted: pw.requirements("0.01"), payload: { transaction: "AAAA" } });
}

interface Script {
  verify?: () => Response;
  settle?: () => Response;
  horizon?: () => Response;
}

function fac(script: Script) {
  const calls: Array<{ path: string; auth: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    calls.push({ path, auth: new Headers(init?.headers).get("authorization") });
    if (path === "/verify") return (script.verify ?? (() => Response.json({ isValid: true, payer: "GPAYER" })))();
    if (path === "/settle") return (script.settle ?? (() => Response.json({ success: true, transaction: TX, network: "stellar:testnet", payer: "GPAYER" })))();
    return (script.horizon ?? (() => new Response("not found", { status: 404 })))();
  };
  return { calls, fetchImpl };
}

function pw(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createPaywall>[0]> = {}) {
  return createPaywall({
    facilitatorUrl: "http://fac.local",
    payTo: SELLER,
    network: "stellar:testnet",
    fetch: fetchImpl,
    confirmAttempts: 2,
    confirmDelayMs: 1,
    ...extra,
  });
}

describe("I-3 credentials in the facilitator URL", () => {
  it("are moved into an Authorization header and never appear in a 402", async () => {
    const { calls, fetchImpl } = fac({ verify: () => new Response("boom", { status: 500 }) });
    const p = pw(fetchImpl, { facilitatorUrl: "http://seller:s3cr3t@fac.local/" });
    const res = await p.handle({ price: "0.01", resource, headers: new Headers({ "PAYMENT-SIGNATURE": header(p) }) });
    expect(JSON.stringify(res)).not.toContain("s3cr3t");
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from("seller:s3cr3t").toString("base64")}`);
    expect(p.config.facilitatorUrl).toBe("http://fac.local");
    if (res.kind === "payment_required") expect(res.body.error).toBe("facilitator_unreachable");
  });
});

describe("M-5 upstream text never reaches the buyer", () => {
  it("a malformed verify answer becomes facilitator_error", async () => {
    const { fetchImpl } = fac({ verify: () => Response.json({ isValid: "yes", internal: "db at 10.0.3.7" }) });
    const p = pw(fetchImpl);
    const res = await p.handle({ price: "0.01", resource, headers: new Headers({ "PAYMENT-SIGNATURE": header(p) }) });
    expect(res.kind).toBe("payment_required");
    if (res.kind !== "payment_required") return;
    expect(res.body.error).toBe("facilitator_error");
    expect(JSON.stringify(res.body)).not.toContain("10.0.3.7");
  });

  it("an invalidReason that is not a plain code is collapsed", async () => {
    const { fetchImpl } = fac({ verify: () => Response.json({ isValid: false, invalidReason: "Error: ECONNREFUSED 10.0.0.1" }) });
    const p = pw(fetchImpl);
    const res = await p.handle({ price: "0.01", resource, headers: new Headers({ "PAYMENT-SIGNATURE": header(p) }) });
    if (res.kind === "payment_required") expect(res.body.error).toBe("payment_invalid");
  });
});

describe("I-4 ambiguous settlement never re-quotes", () => {
  it("settle 502 -> 409 settlement_pending with the same terms, no fresh 402", async () => {
    const { fetchImpl } = fac({ settle: () => new Response("bad gateway", { status: 502 }) });
    const p = pw(fetchImpl);
    const res = await p.handle({ price: "0.01", resource, headers: new Headers({ "PAYMENT-SIGNATURE": header(p) }) });
    expect(res.kind).toBe("settlement_pending");
    if (res.kind !== "settlement_pending") return;
    expect(res.status).toBe(409);
    expect(res.body.accepts[0]).toEqual(p.requirements("0.01"));
    expect(res.headers["retry-after"]).toBeTruthy();
  });

  it("not_confirmed with a hash that Horizon shows successful -> delivered as paid", async () => {
    const { fetchImpl } = fac({
      settle: () => Response.json({ success: false, errorReason: "settle_exact_stellar_transaction_not_confirmed", transaction: TX, network: "stellar:testnet", payer: "GPAYER" }),
      horizon: () => Response.json({ successful: true, hash: TX }),
    });
    const p = pw(fetchImpl);
    const res = await p.handle({ price: "0.01", resource, headers: new Headers({ "PAYMENT-SIGNATURE": header(p) }) });
    expect(res.kind).toBe("paid");
    if (res.kind === "paid") expect(res.settlement).toMatchObject({ success: true, transaction: TX });
  });

  it("unexpected_settle_error with a hash not yet visible -> 409, then the retry delivers once included", async () => {
    let visible = false;
    const { calls, fetchImpl } = fac({
      settle: () => Response.json({ success: false, errorReason: "unexpected_settle_error", transaction: TX, network: "stellar:testnet" }),
      horizon: () => (visible ? Response.json({ successful: true }) : new Response("", { status: 404 })),
    });
    const p = pw(fetchImpl);
    const h = new Headers({ "PAYMENT-SIGNATURE": header(p) });
    const first = await p.handle({ price: "0.01", resource, headers: h });
    expect(first.kind).toBe("settlement_pending");
    if (first.kind === "settlement_pending") expect(first.body.transaction).toBe(TX);
    visible = true;
    const second = await p.handle({ price: "0.01", resource, headers: h });
    expect(second.kind).toBe("paid");
    // The retry went to the chain, not back through /verify or /settle.
    expect(calls.filter((c) => c.path === "/settle")).toHaveLength(1);
  });

  it("a hash the chain reports FAILED -> 402 so the buyer can pay again", async () => {
    const { fetchImpl } = fac({
      settle: () => Response.json({ success: false, errorReason: "settle_exact_stellar_transaction_failed", transaction: TX, network: "stellar:testnet" }),
      horizon: () => Response.json({ successful: false }),
    });
    const p = pw(fetchImpl);
    const res = await p.handle({ price: "0.01", resource, headers: new Headers({ "PAYMENT-SIGNATURE": header(p) }) });
    expect(res.kind).toBe("payment_required");
  });

  it("a pending payment retried against a different resource is refused", async () => {
    const { fetchImpl } = fac({ settle: () => new Response("", { status: 503 }) });
    const p = pw(fetchImpl);
    const h = new Headers({ "PAYMENT-SIGNATURE": header(p) });
    expect((await p.handle({ price: "0.01", resource, headers: h })).kind).toBe("settlement_pending");
    const other = await p.handle({ price: "0.01", resource: { url: "https://seller.example/echo" }, headers: h });
    expect(other.kind).toBe("payment_required");
    if (other.kind === "payment_required") expect(other.body.error).toBe("resource_mismatch");
  });
});

describe("M-4 payment bound to the resource", () => {
  it("a header whose resource.url names another route is refused before settlement", async () => {
    const { calls, fetchImpl } = fac({});
    const p = pw(fetchImpl);
    const res = await p.handle({
      price: "0.01",
      resource: { url: "https://seller.example/echo" },
      headers: new Headers({ "PAYMENT-SIGNATURE": header(p) }),
    });
    expect(res.kind).toBe("payment_required");
    if (res.kind === "payment_required") expect(res.body.error).toBe("resource_mismatch");
    expect(calls.map((c) => c.path)).toEqual(["/verify"]);
  });

  it("a header without a resource is refused", async () => {
    const { fetchImpl } = fac({});
    const p = pw(fetchImpl);
    const h = encodeHeader({ x402Version: 2, accepted: p.requirements("0.01"), payload: { transaction: "AAAA" } });
    const res = await p.handle({ price: "0.01", resource, headers: new Headers({ "PAYMENT-SIGNATURE": h }) });
    if (res.kind === "payment_required") expect(res.body.error).toBe("resource_mismatch");
    expect(res.kind).toBe("payment_required");
  });

  it("query strings do not change the resource identity", () => {
    expect(resourceKey("https://s.example/weather?city=Atlanta")).toBe(resourceKey("https://s.example/weather"));
    expect(resourceKey("https://s.example/weather")).not.toBe(resourceKey("https://s.example/echo"));
  });
});
