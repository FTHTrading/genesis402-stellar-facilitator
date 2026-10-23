import { describe, expect, it } from "vitest";
import { bucketOf } from "../src/app.js";

describe("M-r4-6 IPv4 carried inside IPv6 identifies the IPv4 client", () => {
  it.each([
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["::ffff:cb00:7107", "203.0.113.7"],
    ["::ffff:cb00:7108", "203.0.113.8"],
    ["::ffff:0:203.0.113.7", "203.0.113.7"],
    ["64:ff9b::203.0.113.7", "203.0.113.7"],
    ["64:ff9b::cb00:7107", "203.0.113.7"],
    ["64:ff9b::198.51.100.1", "198.51.100.1"],
    ["64:ff9b:1::c633:6401", "198.51.100.1"],
  ])("%s -> %s", (input, want) => {
    expect(bucketOf(input)).toBe(want);
  });
  it("native IPv6 is still bucketed per /64", () => {
    expect(bucketOf("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(bucketOf("2001:db8:1:2:ffff::")).toBe("2001:db8:1:2::/64");
  });
});
