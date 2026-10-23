import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  InMemoryPendingStore,
  PendingStoreBusyError,
  SqlitePendingStore,
  createPaywall,
  encodeHeader,
  isStoreBusyError,
  type HandleResult,
  type PendingRecord,
  type PendingStore,
} from "../src/index.js";

const SELLER = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";
const TX = "ab".repeat(32);
const resource = { url: "https://seller.example/weather", mimeType: "application/json" };
const code = (r: HandleResult) => (r.kind === "paid" ? 200 : r.status);
const REQ = createPaywall({ facilitatorUrl: "http://f", payTo: SELLER, network: "stellar:testnet" }).requirements("0.01");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rec = (digest: string, state: PendingRecord["state"], extra: Partial<PendingRecord> = {}): PendingRecord => ({
  digest,
  resourceKey: "k",
  method: "GET",
  requirements: REQ,
  claimKey: `key-${digest}`,
  state,
  createdAt: 0,
  expiresAt: Date.now() + 60_000,
  ...extra,
});

/** Facilitator double with real claim semantics; `beforeSettleAnswer` runs after the claim is taken, before the answer returns. */
function facDouble(opts: { beforeSettleAnswer?: () => Promise<void>; hangSettle?: boolean } = {}) {
  const claims = new Map<string, string>();
  let hooked = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const key = new Headers(init?.headers).get("idempotency-key") ?? "";
    const body = JSON.parse(String(init?.body)) as { paymentPayload: { payload: { transaction: string } } };
    const nonce = body.paymentPayload.payload.transaction;
    if (path === "/verify") return Response.json(claims.has(nonce) ? { isValid: false, invalidReason: "invalid_exact_stellar_payload_nonce_reused" } : { isValid: true, payer: "GPAYER" });
    if (opts.hangSettle) return new Promise<Response>(() => undefined);
    const owner = claims.get(nonce);
    if (!owner) claims.set(nonce, key);
    if (!hooked && opts.beforeSettleAnswer) {
      hooked = true;
      await opts.beforeSettleAnswer();
    }
    if (!owner || owner === key) return Response.json({ success: true, transaction: TX, network: "stellar:testnet", payer: "GPAYER" });
    return Response.json({ success: false, errorReason: "invalid_exact_stellar_payload_nonce_reused", transaction: TX, network: "stellar:testnet" });
  };
  return fetchImpl;
}
const mk = (fetchImpl: typeof fetch, store: PendingStore, extra: Record<string, unknown> = {}) =>
  createPaywall({ facilitatorUrl: "http://fac.local", payTo: SELLER, network: "stellar:testnet", fetch: fetchImpl, confirm: async () => "UNKNOWN", confirmAttempts: 1, confirmDelayMs: 1, pendingStore: store, ...extra });
const header = (pw: ReturnType<typeof createPaywall>, tx = "AAAA") => encodeHeader({ x402Version: 2, resource, accepted: pw.requirements("0.01"), payload: { transaction: tx } });
const call = (pw: ReturnType<typeof createPaywall>, h: string) => pw.handle({ price: "0.01", resource, headers: new Headers({ "PAYMENT-SIGNATURE": h }) });
const tmp = (p: string) => join(mkdtempSync(join(tmpdir(), p)), "p.sqlite");

describe("I-r5-1 update() is an owner-checked conditional update that never inserts", () => {
  for (const [name, make] of [
    ["in-memory", () => new InMemoryPendingStore()],
    ["sqlite", () => new SqlitePendingStore(tmp("r5-upd-"))],
  ] as const) {
    it(`${name}: absent record -> false and still absent; tombstone -> false; foreign claim key -> false; live owner -> true`, async () => {
      const s = make();
      expect(await s.update(rec("gone", "pending"))).toBe(false);
      expect(await s.get("gone")).toBeUndefined();
      expect(await s.put(rec("tomb", "expired"))).toBe(true);
      expect(await s.update(rec("tomb", "pending"))).toBe(false);
      expect((await s.get("tomb"))?.state).toBe("expired");
      expect(await s.put(rec("live", "inflight"))).toBe(true);
      expect(await s.update(rec("live", "pending", { claimKey: "someone-else" }))).toBe(false);
      expect((await s.get("live"))?.state).toBe("inflight");
      expect(await s.update(rec("live", "pending", { txHash: TX }))).toBe(true);
      expect(await s.get("live")).toMatchObject({ state: "pending", txHash: TX });
      // consumed by the owner: nothing can bring it back
      expect(await s.consume("live", "key-live")).toBe(true);
      expect(await s.update(rec("live", "pending"))).toBe(false);
      expect(await s.get("live")).toBeUndefined();
    });
  }

  it("sqlite: held() reports a lease that was taken over, so the holder knows before it writes", async () => {
    const path = tmp("r5-held-");
    const s = new SqlitePendingStore(path, { leaseMs: 300, pollMs: 5 });
    const raw = new DatabaseSync(path);
    await s.withLock("d", async (lease) => {
      expect(lease.held()).toBe(true);
      raw.prepare("UPDATE pending_locks SET leased_until = 0").run();
      expect(lease.held()).toBe(false);
    });
    raw.close();
  });

  it("holder whose lease lapsed mid-settle: the taker delivers once, the late holder answers 409 and does not resurrect the record", async () => {
    const path = tmp("r5-lapse-");
    const raw = new DatabaseSync(path);
    let rb: HandleResult | undefined;
    let B: ReturnType<typeof createPaywall> | undefined;
    const fetchImpl = facDouble({
      beforeSettleAnswer: async () => {
        raw.prepare("UPDATE pending_locks SET leased_until = 0").run(); // A's lease is gone
        rb = await call(B!, header(B!)); // B takes over, re-asks with A's claim key, delivers
      },
    });
    const A = mk(fetchImpl, new SqlitePendingStore(path, { leaseMs: 300, pollMs: 5 }));
    B = mk(fetchImpl, new SqlitePendingStore(path, { leaseMs: 300, pollMs: 5 }));
    const ra = await call(A, header(A));
    const rows = raw.prepare("SELECT count(*) AS n FROM pending_payments").get() as { n: number };
    const rc = await call(A, header(A));
    raw.close();
    expect(code(rb!)).toBe(200);
    expect(code(ra)).toBe(409);
    expect(rows.n).toBe(0);
    expect(code(rc)).toBe(402);
  });
});

describe("M-r5-4 the in-memory store bounds the lock wait", () => {
  it("a second caller for a busy digest gets PendingStoreBusyError after lockWaitMs, not the holder's result", async () => {
    const s = new InMemoryPendingStore({ lockWaitMs: 100 });
    const holder = s.withLock("d", () => sleep(600).then(() => "held"));
    const t0 = Date.now();
    await expect(s.withLock("d", async () => "second")).rejects.toBeInstanceOf(PendingStoreBusyError);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(await holder).toBe("held");
    expect(await s.withLock("d", async () => "after")).toBe("after");
  });

  it("through the paywall: 503 settlement_busy with Retry-After", async () => {
    const pw = mk(facDouble({ beforeSettleAnswer: () => sleep(700) }), new InMemoryPendingStore({ lockWaitMs: 100 }));
    const h = header(pw);
    const pa = call(pw, h);
    await sleep(50);
    const rb = await call(pw, h);
    expect(rb.kind).toBe("busy");
    expect(rb.kind === "busy" && rb.body.error).toBe("settlement_busy");
    expect(rb.kind === "busy" && rb.headers["retry-after"]).toBeTruthy();
    expect(code(await pa)).toBe(200);
  });
});

describe("M-r5-2 SQLITE_BUSY past busy_timeout answers 503, never a thrown 500", () => {
  it("isStoreBusyError recognises node:sqlite's 'database is locked'", () => {
    expect(isStoreBusyError(Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 }))).toBe(true);
    expect(isStoreBusyError(new PendingStoreBusyError())).toBe(true);
    expect(isStoreBusyError(new Error("boom"))).toBe(false);
  });

  it("another connection holds an EXCLUSIVE lock for longer than busyTimeoutMs -> handle() answers 503 settlement_busy", async () => {
    const path = tmp("r5-busy-");
    const pw = mk(facDouble(), new SqlitePendingStore(path, { busyTimeoutMs: 20, pollMs: 5 }));
    const blocker = new DatabaseSync(path);
    blocker.exec("BEGIN EXCLUSIVE");
    const r = await call(pw, header(pw));
    blocker.exec("COMMIT");
    blocker.close();
    expect(r.kind).toBe("busy");
    expect(r.kind === "busy" && r.body.error).toBe("settlement_busy");
    expect(code(await call(pw, header(pw)))).toBe(200);
  });
});

describe("M-r5-3 the facilitator call is bounded", () => {
  it("a /settle that never answers returns 409 settlement_pending after facilitatorTimeoutMs; the record stays for the retry", async () => {
    const store = new InMemoryPendingStore();
    const pw = mk(facDouble({ hangSettle: true }), store, { facilitatorTimeoutMs: 200 });
    const t0 = Date.now();
    const r = await call(pw, header(pw));
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(code(r)).toBe(409);
    expect(r.kind === "settlement_pending" && r.body.error).toBe("settlement_pending");
    const [kept] = await Promise.all([store.get((await import("node:crypto")).createHash("sha256").update(header(pw)).digest("hex"))]);
    expect(kept?.state).toBe("pending");
  });
});

describe("M-r5-5 / M-r5-8 sweep hygiene", () => {
  it("sqlite: the sweep runs on the first lock after the interval, not on every lock", async () => {
    const path = tmp("r5-sweep-");
    const s = new SqlitePendingStore(path, { maxTombstones: 5, sweepIntervalMs: 60_000, pollMs: 5 });
    const raw = new DatabaseSync(path);
    const tombstones = () => (raw.prepare("SELECT count(*) AS n FROM pending_payments WHERE state = 'expired'").get() as { n: number }).n;
    const now = Date.now();
    for (let i = 0; i < 20; i++) await s.put(rec(`t${i}`, "expired", { expiresAt: now - i }));
    await s.withLock("x", async () => undefined); // first lock: interval elapsed since construction -> sweep
    expect(tombstones()).toBe(5);
    for (let i = 20; i < 40; i++) await s.put(rec(`t${i}`, "expired", { expiresAt: now - i }));
    await s.withLock("y", async () => undefined); // within the interval -> no sweep
    expect(tombstones()).toBe(25);
    s.sweep();
    expect(tombstones()).toBe(5);
    raw.close();
  });

  it("sqlite: the index on (state, expires_at) exists", () => {
    const path = tmp("r5-index-");
    new SqlitePendingStore(path);
    const raw = new DatabaseSync(path);
    const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
    raw.close();
    expect(names).toContain("pending_payments_state_expires");
  });

  it("sqlite: live rows untouched for abandonedLiveMs are collected; fresh live rows are kept", async () => {
    const s = new SqlitePendingStore(tmp("r5-aband-"), { abandonedLiveMs: 50 });
    await s.put(rec("old", "pending", { expiresAt: 0 }));
    await sleep(80);
    await s.put(rec("fresh", "inflight", { expiresAt: 0 }));
    s.sweep();
    expect(await s.get("old")).toBeUndefined();
    expect((await s.get("fresh"))?.state).toBe("inflight");
  });

  it("in-memory: live rows untouched for abandonedLiveMs are collected on the next write; fresh ones are kept", async () => {
    const s = new InMemoryPendingStore({ abandonedLiveMs: 50 });
    await s.put(rec("old", "pending"));
    await sleep(80);
    await s.put(rec("fresh", "inflight"));
    expect(await s.get("old")).toBeUndefined();
    expect((await s.get("fresh"))?.state).toBe("inflight");
  });
});
