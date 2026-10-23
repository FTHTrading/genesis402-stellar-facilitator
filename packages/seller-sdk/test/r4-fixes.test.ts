import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryPendingStore, PendingStoreBusyError, SqlitePendingStore, createPaywall, encodeHeader, type HandleResult, type PendingRecord } from "../src/index.js";

const SELLER = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";
const TX = "cd".repeat(32);
const resource = { url: "https://seller.example/weather", mimeType: "application/json" };
const code = (r: HandleResult) => (r.kind === "paid" ? 200 : r.status);
const REQ = createPaywall({ facilitatorUrl: "http://f", payTo: SELLER, network: "stellar:testnet" }).requirements("0.01");
const rec = (digest: string, state: PendingRecord["state"], extra: Partial<PendingRecord> = {}): PendingRecord => ({
  digest,
  resourceKey: "k",
  method: "GET",
  requirements: REQ,
  claimKey: `key-${digest}`,
  state,
  createdAt: 0,
  expiresAt: 1,
  ...extra,
});

/** Facilitator double: first /settle stalls `stallMs`, everything confirmed, claim semantics real. */
function facDouble(stallMs = 0) {
  const claims = new Map<string, string>();
  let stalled = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const key = new Headers(init?.headers).get("idempotency-key") ?? "";
    const body = JSON.parse(String(init?.body)) as { paymentPayload: { payload: { transaction: string } } };
    const nonce = body.paymentPayload.payload.transaction;
    if (path === "/verify") return Response.json(claims.has(nonce) ? { isValid: false, invalidReason: "invalid_exact_stellar_payload_nonce_reused" } : { isValid: true, payer: "GPAYER" });
    if (stallMs && !stalled) {
      stalled = true;
      await new Promise((r) => setTimeout(r, stallMs));
    }
    const owner = claims.get(nonce);
    if (!owner) {
      claims.set(nonce, key);
      return Response.json({ success: true, transaction: TX, network: "stellar:testnet", payer: "GPAYER" });
    }
    if (owner === key) return Response.json({ success: true, transaction: TX, network: "stellar:testnet", payer: "GPAYER" });
    return Response.json({ success: false, errorReason: "invalid_exact_stellar_payload_nonce_reused", transaction: TX, network: "stellar:testnet" });
  };
  return fetchImpl;
}
const mk = (fetchImpl: typeof fetch, store: SqlitePendingStore | InMemoryPendingStore) =>
  createPaywall({ facilitatorUrl: "http://fac.local", payTo: SELLER, network: "stellar:testnet", fetch: fetchImpl, confirm: async () => "UNKNOWN", confirmAttempts: 1, confirmDelayMs: 1, pendingStore: store });
const header = (pw: ReturnType<typeof createPaywall>) => encodeHeader({ x402Version: 2, resource, accepted: pw.requirements("0.01"), payload: { transaction: "AAAA" } });
const call = (pw: ReturnType<typeof createPaywall>, h: string) => pw.handle({ price: "0.01", resource, headers: new Headers({ "PAYMENT-SIGNATURE": h }) });

describe("C-r4-1 one delivery even when a lease expires under a slow request", () => {
  it("lease renewed while the holder runs: a second instance waits instead of taking over; one 200", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r4-lease-"));
    const fetchImpl = facDouble(900);
    const A = mk(fetchImpl, new SqlitePendingStore(join(dir, "p.sqlite"), { leaseMs: 300, pollMs: 5 }));
    const B = mk(fetchImpl, new SqlitePendingStore(join(dir, "p.sqlite"), { leaseMs: 300, pollMs: 5 }));
    const h = header(A);
    const pa = call(A, h);
    await new Promise((r) => setTimeout(r, 400));
    const rb = await call(B, h);
    const ra = await pa;
    expect([ra, rb].filter((r) => r.kind === "paid")).toHaveLength(1);
  });

  it("even if a lease is lost, delivery is gated by the atomic consume: the loser answers 409, never 200", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r4-consume-"));
    const a = new SqlitePendingStore(join(dir, "p.sqlite"));
    const b = new SqlitePendingStore(join(dir, "p.sqlite"));
    await a.put(rec("d", "pending", { claimKey: "k1" }));
    expect(await b.consume("d", "k1")).toBe(true);
    expect(await a.consume("d", "k1")).toBe(false);
    const m = new InMemoryPendingStore();
    await m.put(rec("d", "pending", { claimKey: "k1" }));
    expect(await m.consume("d", "wrong")).toBe(false);
    expect(await m.consume("d", "k1")).toBe(true);
    expect(await m.consume("d", "k1")).toBe(false);
  });

  it("a request that cannot get the lock within lockWaitMs answers 503 settlement_busy with Retry-After", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r4-busy-"));
    const path = join(dir, "p.sqlite");
    const holder = new SqlitePendingStore(path, { leaseMs: 5_000 });
    const waiter = new SqlitePendingStore(path, { leaseMs: 5_000, lockWaitMs: 100, pollMs: 5 });
    let release!: () => void;
    const held = holder.withLock("digest-x", () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));
    await expect(waiter.withLock("digest-x", async () => "no")).rejects.toBeInstanceOf(PendingStoreBusyError);
    const pw = mk(facDouble(), waiter);
    // The paywall maps the same condition to a 503; the digest here is the header's sha256, so hold that one.
    const h = header(pw);
    const digest = (await import("node:crypto")).createHash("sha256").update(h).digest("hex");
    let release2!: () => void;
    const held2 = holder.withLock(digest, () => new Promise<void>((r) => (release2 = r)));
    await new Promise((r) => setTimeout(r, 20));
    const r = await call(pw, h);
    expect(r.kind).toBe("busy");
    expect(code(r)).toBe(503);
    if (r.kind === "busy") expect(r.headers["retry-after"]).toBeTruthy();
    release();
    release2();
    await held;
    await held2;
  });
});

describe("M-r4-4 eviction and sweeping", () => {
  it("in-memory: live records are never evicted; tombstones go oldest first and stay bounded", async () => {
    const s = new InMemoryPendingStore(100);
    await s.put(rec("live", "pending", { expiresAt: Date.now() + 100_000 }));
    for (let i = 0; i < 500; i++) await s.put(rec(`t${i}`, "expired", { expiresAt: i }));
    expect(await s.get("live")).toBeDefined();
    const size = (s as unknown as { records: Map<string, unknown> }).records.size;
    expect(size).toBe(101);
    expect(await s.get("t0")).toBeUndefined();
    expect(await s.get("t499")).toBeDefined();
  });

  it("sqlite: the sweep on lock removes tombstones past retention and beyond the cap, never live records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r4-sweep-"));
    // Retention 60 s: "old" tombstones expired two minutes ago (past retention), "new" ones within the last 80 ms.
    const s = new SqlitePendingStore(join(dir, "p.sqlite"), { tombstoneRetentionMs: 60_000, maxTombstones: 50 });
    const now = Date.now();
    await s.put(rec("live", "pending", { expiresAt: now + 100_000 }));
    for (let i = 0; i < 200; i++) await s.put(rec(`old${i}`, "expired", { expiresAt: now - 120_000 - i }));
    for (let i = 0; i < 80; i++) await s.put(rec(`new${i}`, "expired", { expiresAt: now - i }));
    const count = () => (s as unknown as { db: { prepare: (q: string) => { get: () => { n: number } } } }).db.prepare("SELECT count(*) AS n FROM pending_payments").get().n;
    expect(count()).toBe(281);
    await s.withLock("any", async () => undefined);
    expect(await s.get("live")).toBeDefined();
    expect(count()).toBe(51); // live + the 50 newest tombstones
  });
});
