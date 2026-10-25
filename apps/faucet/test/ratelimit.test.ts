import { describe, expect, it } from "vitest";
import { ClaimLimiter } from "../src/ratelimit.js";
import { sqliteD1 } from "./sqlite-d1.js";

const DAY = 24 * 60 * 60 * 1000;

function limiter(perAddress = 1, perIp = 1) {
  return new ClaimLimiter(sqliteD1(), { windowMs: DAY, perAddress, perIp });
}

describe("ClaimLimiter", () => {
  it("allows one claim per address per token per window", async () => {
    const l = limiter(1, 10);
    const t0 = 1_000_000;
    expect((await l.reserve("g402t", "GA", "1.1.1.1", t0)).ok).toBe(true);
    const second = await l.reserve("g402t", "GA", "2.2.2.2", t0 + 1000);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.scope).toBe("address");
      expect(second.retryAfterSec).toBe(Math.ceil((DAY - 1000) / 1000));
    }
  });

  it("allows one claim per IP per token per window", async () => {
    const l = limiter(10, 1);
    const t0 = 1_000_000;
    expect((await l.reserve("g402t", "GA", "1.1.1.1", t0)).ok).toBe(true);
    const r = await l.reserve("g402t", "GB", "1.1.1.1", t0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.scope).toBe("ip");
  });

  it("an IP refusal does not consume the address slot", async () => {
    const l = limiter(1, 1);
    const t0 = 1_000_000;
    expect((await l.reserve("g402t", "GA", "1.1.1.1", t0)).ok).toBe(true);
    expect((await l.reserve("g402t", "GB", "1.1.1.1", t0)).ok).toBe(false);
    // GB never got anything, so from a fresh IP it can still claim.
    expect((await l.reserve("g402t", "GB", "3.3.3.3", t0)).ok).toBe(true);
  });

  it("tokens are limited independently", async () => {
    const l = limiter();
    const t0 = 1_000_000;
    expect((await l.reserve("xlm", "GA", "1.1.1.1", t0)).ok).toBe(true);
    expect((await l.reserve("g402t", "GA", "1.1.1.1", t0)).ok).toBe(true);
  });

  it("opens again after 24h", async () => {
    const l = limiter();
    const t0 = 1_000_000;
    expect((await l.reserve("g402t", "GA", "1.1.1.1", t0)).ok).toBe(true);
    expect((await l.reserve("g402t", "GA", "1.1.1.1", t0 + DAY - 1)).ok).toBe(false);
    expect((await l.reserve("g402t", "GA", "1.1.1.1", t0 + DAY)).ok).toBe(true);
  });

  it("release gives the slot back (used when nothing was sent)", async () => {
    const l = limiter();
    const t0 = 1_000_000;
    const r = await l.reserve("g402t", "GA", "1.1.1.1", t0);
    expect(r.ok).toBe(true);
    if (r.ok) await r.release();
    expect((await l.reserve("g402t", "GA", "1.1.1.1", t0 + 5)).ok).toBe(true);
  });

  it("S2: 20 parallel reservations for one address yield exactly one", async () => {
    const l = limiter(1, 1000);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => l.reserve("g402t", "GSAME", `10.0.0.${i}`, 5_000)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("S2: 20 parallel reservations from one IP yield exactly one", async () => {
    const l = limiter(1000, 1);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => l.reserve("g402t", `G${i}`, "9.9.9.9", 5_000)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});
