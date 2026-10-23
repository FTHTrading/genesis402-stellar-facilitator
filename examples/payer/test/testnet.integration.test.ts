import { describe, expect, it } from "vitest";
import { runTestnetDemo } from "../src/demo.js";

const enabled = process.env["STELLAR_TESTNET_TESTS"] === "1";

/**
 * Real Stellar testnet round trip. Opt in with STELLAR_TESTNET_TESTS=1
 * (`npm run test:testnet`). Needs outbound HTTPS to friendbot, Horizon and
 * Soroban RPC; takes about a minute.
 */
describe.skipIf(!enabled)("stellar testnet end-to-end", () => {
  it("settles one paid call and refuses the replay", async () => {
    const r = await runTestnetDemo(process.env, () => {});
    expect(r.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.settlement.success).toBe(true);
    expect(r.settlement.network).toBe("stellar:testnet");
    expect(r.settlement.payer).toBe(r.payer);
    expect(r.discovered.some((e) => e.endsWith("/weather"))).toBe(true);
    expect(r.replayRefused).toBe(true);
    expect(Number(r.payerBalanceAfter)).toBeLessThan(Number(r.payerBalanceBefore));
    expect(Number(r.sellerBalanceAfter)).toBeGreaterThan(0);
  }, 300_000);
});
