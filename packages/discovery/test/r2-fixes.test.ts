import { describe, expect, it } from "vitest";
import { createDiscoveryApp } from "../src/app.js";
import { SqliteResourceIndex } from "../src/index-store.js";

describe("I-2r2 X-Forwarded-For identity under TRUST_PROXY", () => {
  const body = JSON.stringify({ manifest_url: "https://victim.example/.well-known/x402" });
  const make = (extra: Partial<Parameters<typeof createDiscoveryApp>[0]> = {}) =>
    createDiscoveryApp({
      index: new SqliteResourceIndex(":memory:"),
      resolve: async () => [],
      fetch: async () => new Response("", { status: 500 }),
      trustProxy: true,
      ...extra,
    });
  const post = (app: ReturnType<typeof make>, xff: string) =>
    app.request("http://d/discovery/sellers", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": xff }, body });

  it("uses the rightmost hop: a client spoofing the left entry behind an appending proxy shares one bucket", async () => {
    const app = make();
    let accepted = 0;
    for (let i = 0; i < 20; i++) if ((await post(app, `10.9.${i}.1, 192.0.2.77`)).status === 202) accepted++;
    expect(accepted).toBe(5);
  });

  it("TRUST_PROXY_HOPS=2 identifies the client behind two appending proxies", async () => {
    const app = make({ trustProxyHops: 2 });
    for (let i = 0; i < 5; i++) expect((await post(app, `1.1.1.${i}, 203.0.113.5, 192.0.2.77`)).status).toBe(202);
    expect((await post(app, "1.1.1.9, 203.0.113.5, 192.0.2.77")).status).toBe(429);
    expect((await post(app, "1.1.1.9, 203.0.113.6, 192.0.2.77")).status).toBe(202);
  });

  it("a single-hop header (overwriting proxy) is the identity", async () => {
    const app = make();
    for (let i = 0; i < 5; i++) expect((await post(app, "192.0.2.77")).status).toBe(202);
    expect((await post(app, "192.0.2.77")).status).toBe(429);
    expect((await post(app, "192.0.2.78")).status).toBe(202);
  });
});
