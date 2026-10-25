import { Keypair, StrKey } from "@stellar/stellar-sdk/base";
import { describe, expect, it } from "vitest";
import { checkAddress } from "../src/address.js";

describe("checkAddress", () => {
  const g = Keypair.random().publicKey();

  it("accepts a valid G-address and trims whitespace", () => {
    expect(checkAddress(`  ${g}\n`)).toEqual({ ok: true, address: g });
  });

  it("rejects missing or non-string input", () => {
    for (const bad of [undefined, null, "", 42, {}, []]) {
      const r = checkAddress(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("address_missing");
    }
  });

  it("rejects a bad checksum", () => {
    const broken = g.slice(0, 55) + (g[55] === "A" ? "B" : "A");
    const r = checkAddress(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("address_invalid");
  });

  it("rejects lowercase", () => {
    const r = checkAddress(g.toLowerCase());
    expect(r.ok).toBe(false);
  });

  it("rejects muxed M-addresses with a specific message", () => {
    const muxed = StrKey.encodeMed25519PublicKey(new Uint8Array(40).fill(7) as never);
    expect(muxed.startsWith("M")).toBe(true);
    const r = checkAddress(muxed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("address_muxed");
  });

  it("rejects contract C-addresses with a specific message", () => {
    const contract = StrKey.encodeContract(new Uint8Array(32).fill(9) as never);
    const r = checkAddress(contract);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("address_contract");
  });

  it("rejects a pasted secret key and warns", () => {
    const r = checkAddress(Keypair.random().secret());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("address_is_secret");
      expect(r.message).toMatch(/secret/i);
    }
  });

  it("rejects absurdly long input without parsing it", () => {
    const r = checkAddress("G".repeat(5000));
    expect(r.ok).toBe(false);
  });
});
