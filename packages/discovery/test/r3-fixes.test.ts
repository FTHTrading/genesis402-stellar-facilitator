import { describe, expect, it } from "vitest";
import { bucketOf, createDiscoveryApp } from "../src/app.js";
import { SqliteResourceIndex } from "../src/index-store.js";

describe("M-r3-3 hop count never falls back to the client-chosen hop", () => {
  const body = JSON.stringify({ manifest_url: "https://victim.example/.well-known/x402" });
  const make = (hops: number) =>
    createDiscoveryApp({ index: new SqliteResourceIndex(":memory:"), resolve: async () => [], fetch: async () => new Response("", { status: 500 }), trustProxy: true, trustProxyHops: hops });
  const post = (app: ReturnType<typeof make>, xff: string) =>
    app.request("http://d/discovery/sellers", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": xff }, body });

  it.each([NaN, 0, -1, 1.5, 99])("hops=%s with a 2-entry chain uses the rightmost entry", async (hops) => {
    const app = make(hops);
    let accepted = 0;
    for (let i = 0; i < 12; i++) if ((await post(app, `198.51.100.${i}, 192.0.2.77`)).status === 202) accepted++;
    expect(accepted).toBe(5);
  });
});

describe("M-r3-4 IPv6 identity per /64", () => {
  it("buckets addresses in one /64 together, keeps IPv4 and mapped-IPv4 per address", () => {
    expect(bucketOf("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(bucketOf("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(bucketOf("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(bucketOf("[2001:DB8:1:2::9]")).toBe("2001:db8:1:2::/64");
    expect(bucketOf("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(bucketOf("1.2.3.4")).toBe("1.2.3.4");
    expect(bucketOf("garbage")).toBe("garbage");
  });

  it("rotating addresses inside one /64 behind a trusted proxy share one bucket", async () => {
    const app = createDiscoveryApp({ index: new SqliteResourceIndex(":memory:"), resolve: async () => [], fetch: async () => new Response("", { status: 500 }), trustProxy: true });
    let accepted = 0;
    for (let i = 0; i < 20; i++) {
      const res = await app.request("http://d/discovery/sellers", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `2001:db8:1:2::${i.toString(16)}` },
        body: JSON.stringify({ manifest_url: `https://s${i}.example/.well-known/x402` }),
      });
      if (res.status === 202) accepted++;
    }
    expect(accepted).toBe(5);
  });
});
