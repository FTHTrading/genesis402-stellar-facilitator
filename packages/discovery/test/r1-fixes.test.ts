import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createDiscoveryApp } from "../src/app.js";
import { crawlManifest } from "../src/crawler.js";
import { SqliteResourceIndex } from "../src/index-store.js";
import { pinnedDispatcher } from "../src/pinned-fetch.js";
import { isPublicAddress, resolveSafeTarget } from "../src/url-guard.js";

const PUBLIC = "93.184.215.14";

describe("M-6 embedded-IPv4 and NAT64 forms", () => {
  it.each(["::7f00:1", "::ffff:0:7f00:1", "64:ff9b:1::a00:1", "::ffff:0:127.0.0.1", "::127.0.0.1", "2002:7f00:1::", "64:ff9b::a00:1"])(
    "%s is not public",
    (a) => expect(isPublicAddress(a)).toBe(false),
  );
  it.each(["2606:4700::1111", "2a00:1450:4001:80e::200e", "64:ff9b::5db8:d70e", "::ffff:93.184.215.14"])(
    "%s is public",
    (a) => expect(isPublicAddress(a)).toBe(true),
  );
  it("returns the vetted addresses so the caller can pin the connection", async () => {
    await expect(resolveSafeTarget("https://seller.example/x", { resolve: async () => [PUBLIC] })).resolves.toEqual([PUBLIC]);
  });
});

describe("M-7 DNS pinning", () => {
  it("the pinned dispatcher resolves every hostname to the vetted address", async () => {
    const d = pinnedDispatcher([PUBLIC]) as unknown as { [k: symbol]: unknown };
    expect(d).toBeTruthy();
    // Observe the pin end to end: a local listener must never be reached when the guard saw a public address.
    let hits = 0;
    const server = createServer((_q, r) => {
      hits++;
      r.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const err = await crawlManifest(`http://localhost:${port}/.well-known/x402`, {
        allowHttp: true,
        allowPrivate: true, // the name is local; what we test is that the socket goes to the pinned (unreachable) address
        resolve: async () => ["192.0.2.1"],
        timeoutMs: 1500,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  }, 20_000);
});

describe("I-5 client identity for the registration limit", () => {
  const body = JSON.stringify({ manifest_url: "https://victim.example/.well-known/x402" });
  const make = (extra: Partial<Parameters<typeof createDiscoveryApp>[0]> = {}) =>
    createDiscoveryApp({
      index: new SqliteResourceIndex(":memory:"),
      resolve: async () => [],
      fetch: async () => new Response("", { status: 500 }),
      ...extra,
    });
  const post = (app: ReturnType<typeof make>, headers: Record<string, string> = {}) =>
    app.request("http://d/discovery/sellers", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  it("ignores X-Forwarded-For unless the proxy is trusted: rotating it shares one bucket", async () => {
    const app = make();
    let accepted = 0;
    for (let i = 0; i < 20; i++) if ((await post(app, { "x-forwarded-for": `198.51.100.${i}` })).status === 202) accepted++;
    expect(accepted).toBe(5);
  });

  it("with TRUST_PROXY the forwarded address is the identity", async () => {
    const app = make({ trustProxy: true });
    for (let i = 0; i < 5; i++) expect((await post(app, { "x-forwarded-for": "203.0.113.9" })).status).toBe(202);
    expect((await post(app, { "x-forwarded-for": "203.0.113.9" })).status).toBe(429);
    expect((await post(app, { "x-forwarded-for": "203.0.113.10" })).status).toBe(202);
  });

  it("unidentified clients (no socket, no trusted header) share a coarse bucket, not a single-client one", async () => {
    const app = make();
    let accepted = 0;
    for (let i = 0; i < 30; i++) if ((await post(app)).status === 202) accepted++;
    expect(accepted).toBe(20);
  });

  it("the crawl queue is bounded", async () => {
    // A fetch that never resolves keeps the first job running; the rest queue up to maxQueue.
    const app = make({ fetch: () => new Promise<Response>(() => undefined), resolve: async () => [PUBLIC], maxQueue: 2, registrationsPerWindow: 100 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(app, { "x-forwarded-for": "x" })).status);
    expect(statuses).toEqual([202, 202, 202, 503, 503]);
  });
});
