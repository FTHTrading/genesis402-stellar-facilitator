import { describe, expect, it } from "vitest";
import { SqliteNonceStore } from "../src/nonce-store.js";

describe("SqliteNonceStore", () => {
  it("consumes a nonce once and refuses the replay", () => {
    const store = new SqliteNonceStore(":memory:");
    expect(store.isConsumed("stellar:testnet", "GPAYER", "1")).toBe(false);
    expect(store.consume("stellar:testnet", "GPAYER", "1", "txhash1")).toBe(true);
    expect(store.isConsumed("stellar:testnet", "GPAYER", "1")).toBe(true);
    expect(store.consume("stellar:testnet", "GPAYER", "1", "txhash2")).toBe(false);
  });

  it("keeps nonces separate per network and payer", () => {
    const store = new SqliteNonceStore(":memory:");
    expect(store.consume("stellar:testnet", "GPAYER", "1", "h")).toBe(true);
    expect(store.consume("stellar:pubnet", "GPAYER", "1", "h")).toBe(true);
    expect(store.consume("stellar:testnet", "GOTHER", "1", "h")).toBe(true);
  });
});
