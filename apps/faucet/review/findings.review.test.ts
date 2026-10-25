// Phase 4 review: each test here encodes a finding and is EXPECTED TO FAIL against 6ef2673.
import { beforeEach, describe, expect, it } from "vitest";
import { addr, call, makeFaucet, World } from "./harness.js";

let world: World;
let clock: { t: number };
let faucet: ReturnType<typeof makeFaucet>;
beforeEach(() => {
  world = new World();
  clock = { t: 1_800_000_000_000 };
  faucet = makeFaucet(world, clock);
});

const H = (ip: string) => ({ "content-type": "application/json", "cf-connecting-ip": ip });

describe("I-1 per-IP limit is keyed on the full IPv6 address", () => {
  it("I-1: ten addresses from ten IPv6 hosts inside ONE /64 get at most one G402T payment", async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 10; i++) {
      // One residential/VPS customer is normally delegated a whole /64 (2^64 addresses).
      const r = await call(faucet, "/api/claim/g402t", JSON.stringify({ address: addr() }), H(`2001:db8:1234:5678::${i.toString(16)}`));
      statuses.push(r.status);
    }
    expect(world.submitted.length).toBeLessThanOrEqual(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
  });
});

describe("I-2 no global per-day cap on G402T payouts", () => {
  it("I-2: 1,001 claims from distinct IPs/addresses in one day: the faucet stops at a global daily ceiling (recommended 1,000 claims = 1,000,000 G402T/day)", async () => {
    let paid = 0;
    for (let i = 0; i < 1001; i++) {
      const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      const r = await call(faucet, "/api/claim/g402t", JSON.stringify({ address: addr() }), H(ip));
      if (r.status === 200) paid++;
      clock.t += 1000;
    }
    expect(paid).toBeLessThanOrEqual(1000);
  });
});

describe("I-3 claimed effect: a submit Horizon refused outright is reported as 'sent' and burns the slot", () => {
  it("I-3: Horizon 429 on POST /transactions (rate limited, never submitted) is not reported as sent, and the user may retry", async () => {
    const a = addr();
    world.submitResponses.push({ status: 429, body: { type: "https://stellar.org/horizon-errors/rate_limit_exceeded", title: "Rate Limit Exceeded", status: 429 } });
    const first = await call(faucet, "/api/claim/g402t", JSON.stringify({ address: a }));
    expect(first.body.message ?? "").not.toMatch(/was sent/i);
    expect(first.body.explorer).toBeUndefined();
    const retry = await call(faucet, "/api/claim/g402t", JSON.stringify({ address: a }));
    expect(retry.status).toBe(200);
  });
});

describe("M-1 failed outcomes return the slot, so one IP can proxy unlimited upstream calls", () => {
  it("M-1: 50 XLM claims from one IP while Friendbot answers 400 cause at most a handful of Friendbot calls", async () => {
    world.friendbot = { status: 400, body: { detail: "createAccountAlreadyExist" } };
    for (let i = 0; i < 50; i++) await call(faucet, "/api/claim/xlm", JSON.stringify({ address: addr() }), H("203.0.113.99"));
    expect(world.calls.filter((c) => c.url.startsWith("https://friendbot")).length).toBeLessThanOrEqual(5);
  });

  it("M-1b: 50 G402T claims from one IP for no-trustline addresses cause at most a handful of Horizon calls", async () => {
    for (let i = 0; i < 50; i++) {
      const a = addr();
      world.noTrustline.add(a);
      await call(faucet, "/api/claim/g402t", JSON.stringify({ address: a }), H("203.0.113.98"));
    }
    expect(world.calls.length).toBeLessThanOrEqual(5);
  });
});

describe("M-2 body is fully buffered before the 2 KB check", () => {
  it("M-2: an 8 MB streamed body is not read past ~64 KB before 413", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (pulled >= 8 * 1024 * 1024) return ctrl.close();
        pulled += chunk.length;
        ctrl.enqueue(chunk);
      },
    });
    const res = await faucet.handle(
      new Request("https://faucet.review/api/claim/g402t", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.5" },
        body: stream,
        // @ts-expect-error node fetch needs duplex for stream bodies
        duplex: "half",
      }),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(128 * 1024);
  });
});
