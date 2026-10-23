import { describe, expect, it } from "vitest";
import { crawlManifest, CrawlError } from "../src/crawler.js";
import { assertSafeTarget } from "../src/url-guard.js";
import { createDiscoveryApp } from "../src/app.js";
import { SqliteResourceIndex } from "../src/index-store.js";
import { ORIGIN, SELLER, mockSeller } from "./mock-seller.js";
import { publicResolver, waitForJob } from "./jobs.js";

function manifestFor(services: Array<{ name: string; endpoint: string }>, origin = ORIGIN) {
  return {
    x402Version: 2,
    provider: { name: "S", operator: "O", origin, contact: "x@example.com" },
    status: "testnet",
    services: services.map((s) => ({
      name: s.name,
      endpoint: s.endpoint,
      method: "GET",
      title: "t",
      what_you_get: "w",
      price_usd: "0.01",
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          amount: "100000",
          payTo: SELLER,
          maxTimeoutSeconds: 60,
          extra: { areFeesSponsored: true },
        },
      ],
    })),
    accepts: [],
    generated_at: new Date().toISOString(),
  };
}

function countingFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    expect((init as RequestInit | undefined)?.redirect).toBe("manual");
    return handler(url);
  };
  return { calls, fetchImpl };
}

describe("assertSafeTarget (SSRF guard)", () => {
  const cases: Array<[string, string]> = [
    ["https://127.0.0.1/x", "loopback"],
    ["https://10.0.0.5/.well-known/x402", "RFC1918 10/8"],
    ["https://172.16.3.4/x", "RFC1918 172.16/12"],
    ["https://192.168.1.1/x", "RFC1918 192.168/16"],
    ["https://169.254.169.254/latest/meta-data", "cloud metadata / link-local"],
    ["https://100.64.0.1/x", "shared address space"],
    ["https://[::1]/x", "IPv6 loopback"],
    ["https://[fd00:ec2::254]/x", "IPv6 unique-local (metadata)"],
    ["https://[fe80::1]/x", "IPv6 link-local"],
    ["https://224.0.0.1/x", "multicast"],
    ["https://[::ffff:10.0.0.1]/x", "v4-mapped private"],
    ["https://0.0.0.0/x", "unspecified"],
  ];
  for (const [url, why] of cases) {
    it(`rejects ${why}: ${url}`, async () => {
      await expect(assertSafeTarget(url, { resolve: publicResolver })).rejects.toMatchObject({
        code: "target_not_allowed",
      });
    });
  }

  it("rejects plain http unless explicitly allowed", async () => {
    await expect(assertSafeTarget("http://seller.example/x", { resolve: publicResolver })).rejects.toMatchObject({
      code: "target_not_allowed",
    });
    await expect(
      assertSafeTarget("http://seller.example/x", { resolve: publicResolver, allowHttp: true }),
    ).resolves.toBeUndefined();
  });

  it("rejects a public hostname that resolves to a private address", async () => {
    await expect(
      assertSafeTarget("https://evil.example/x", { resolve: async () => ["1.2.3.4", "10.9.9.9"] }),
    ).rejects.toMatchObject({ code: "target_not_allowed" });
  });

  it("rejects credentials in the URL and non-http schemes", async () => {
    await expect(assertSafeTarget("https://user:pw@seller.example/x", { resolve: publicResolver })).rejects.toMatchObject({
      code: "target_not_allowed",
    });
    await expect(assertSafeTarget("file:///etc/passwd", { resolve: publicResolver })).rejects.toMatchObject({
      code: "target_not_allowed",
    });
  });

  it("accepts a public https host", async () => {
    await expect(assertSafeTarget("https://seller.example/x", { resolve: publicResolver })).resolves.toBeUndefined();
  });
});

describe("crawlManifest hardening", () => {
  it("never fetches a private-IP manifest", async () => {
    const { calls, fetchImpl } = countingFetch(() => Response.json({}));
    await expect(
      crawlManifest("https://10.0.0.5/.well-known/x402", { fetch: fetchImpl, resolve: publicResolver }),
    ).rejects.toBeInstanceOf(CrawlError);
    expect(calls).toEqual([]);
  });

  it("never fetches the cloud metadata address", async () => {
    const { calls, fetchImpl } = countingFetch(() => Response.json({}));
    await expect(
      crawlManifest("https://169.254.169.254/latest/meta-data", { fetch: fetchImpl, resolve: publicResolver }),
    ).rejects.toMatchObject({ code: "target_not_allowed" });
    expect(calls).toEqual([]);
  });

  it("pins seller_origin to the manifest URL and skips cross-origin endpoints without fetching them", async () => {
    const body = manifestFor([
      { name: "ok", endpoint: `${ORIGIN}/ok` },
      { name: "evil", endpoint: "https://attacker.example/steal" },
    ]);
    const seller = mockSeller();
    const { calls, fetchImpl } = countingFetch((url) =>
      url.endsWith("/.well-known/x402") ? Response.json(body) : seller.fetchImpl(url.replace("/ok", "/weather")),
    );
    const result = await crawlManifest(`${ORIGIN}/.well-known/x402`, { fetch: fetchImpl, resolve: publicResolver });
    expect(result.seller_origin).toBe(ORIGIN);
    expect(result.listed.map((r) => r.name)).toEqual(["ok"]);
    expect(result.skipped).toEqual([{ endpoint: "https://attacker.example/steal", reason: "cross_origin_endpoint" }]);
    expect(calls.some((u) => u.includes("attacker.example"))).toBe(false);
  });

  it("rejects a manifest whose provider.origin names a different host", async () => {
    const body = manifestFor([{ name: "a", endpoint: `${ORIGIN}/a` }], "https://impostor.example");
    const { fetchImpl } = countingFetch(() => Response.json(body));
    await expect(
      crawlManifest(`${ORIGIN}/.well-known/x402`, { fetch: fetchImpl, resolve: publicResolver }),
    ).rejects.toMatchObject({ code: "origin_mismatch" });
  });

  it("aborts a manifest body larger than 256 KiB", async () => {
    const huge = JSON.stringify({ pad: "x".repeat(300 * 1024) });
    const { fetchImpl } = countingFetch(
      () => new Response(huge, { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(
      crawlManifest(`${ORIGIN}/.well-known/x402`, { fetch: fetchImpl, resolve: publicResolver }),
    ).rejects.toMatchObject({ code: "body_too_large" });
  });

  it("rejects a manifest served without a JSON content type", async () => {
    const { fetchImpl } = countingFetch(
      () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    await expect(
      crawlManifest(`${ORIGIN}/.well-known/x402`, { fetch: fetchImpl, resolve: publicResolver }),
    ).rejects.toMatchObject({ code: "manifest_invalid" });
  });

  it("processes at most 50 services and reports the rest as skipped", async () => {
    const services = Array.from({ length: 60 }, (_, i) => ({ name: `s${i}`, endpoint: `${ORIGIN}/s${i}` }));
    const body = manifestFor(services);
    const quote = {
      x402Version: 2,
      resource: { url: `${ORIGIN}/x` },
      accepts: body.services[0]!.accepts,
    };
    const { calls, fetchImpl } = countingFetch((url) =>
      url.endsWith("/.well-known/x402")
        ? Response.json(body)
        : new Response(JSON.stringify(quote), { status: 402, headers: { "content-type": "application/json" } }),
    );
    const result = await crawlManifest(`${ORIGIN}/.well-known/x402`, { fetch: fetchImpl, resolve: publicResolver });
    expect(result.listed).toHaveLength(50);
    expect(result.skipped).toHaveLength(10);
    expect(result.skipped.every((s) => s.reason === "services_cap_exceeded")).toBe(true);
    expect(calls).toHaveLength(51);
  });
});

describe("discovery API hardening", () => {
  it("queues registration as a job, never echoes internals, and reports a fixed error code", async () => {
    const seller = mockSeller();
    const app = createDiscoveryApp({
      index: new SqliteResourceIndex(":memory:"),
      fetch: seller.fetchImpl,
      resolve: publicResolver,
    });
    const res = await app.request("/discovery/sellers", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ manifest_url: "https://10.0.0.5/.well-known/x402" }),
    });
    expect(res.status).toBe(202);
    const { job_id } = (await res.json()) as { job_id: string };
    expect(job_id).toMatch(/^[0-9a-f-]{36}$/);
    const job = await waitForJob(app, job_id);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("target_not_allowed");
    expect(JSON.stringify(job)).not.toMatch(/10\.0\.0\.5|stack|ENOTFOUND|Error:/);
  });

  it("rate-limits registrations per client IP", async () => {
    const app = createDiscoveryApp({
      index: new SqliteResourceIndex(":memory:"),
      fetch: async () => Response.json({}),
      resolve: publicResolver,
      registrationsPerWindow: 3,
    });
    const post = (ip: string) =>
      app.request("/discovery/sellers", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ manifest_url: `https://seller.example/${Math.random()}` }),
      });
    expect((await post("198.51.100.1")).status).toBe(202);
    expect((await post("198.51.100.1")).status).toBe(202);
    expect((await post("198.51.100.1")).status).toBe(202);
    expect((await post("198.51.100.1")).status).toBe(429);
    expect((await post("198.51.100.2")).status).toBe(202);
  });

  it("allows cross-origin reads but not cross-origin registration", async () => {
    const app = createDiscoveryApp({ index: new SqliteResourceIndex(":memory:"), resolve: publicResolver });
    const read = await app.request("/discovery/resources", { headers: { origin: "https://buyer.example" } });
    expect(read.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await app.request("/discovery/sellers", {
      method: "OPTIONS",
      headers: { origin: "https://buyer.example", "access-control-request-method": "POST" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    const write = await app.request("/discovery/sellers", {
      method: "POST",
      headers: { origin: "https://buyer.example", "content-type": "application/json" },
      body: JSON.stringify({ manifest_url: "https://seller.example/.well-known/x402" }),
    });
    expect(write.headers.get("access-control-allow-origin")).toBeNull();
  });
});

