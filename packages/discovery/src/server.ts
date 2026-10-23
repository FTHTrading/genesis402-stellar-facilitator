import { serve } from "@hono/node-server";
import { realpathSync } from "node:fs";
import { createDiscoveryApp } from "./app.js";
import { SqliteResourceIndex } from "./index-store.js";

/**
 * Standalone discovery index.
 *   DISCOVERY_DB_PATH        SQLite file (default ./discovery.sqlite)
 *   TRUST_PROXY=1            trust X-Forwarded-For for client identity (only behind a proxy that sets it)
 *   DISCOVERY_ALLOW_LOCAL=1  permit http:// and private crawl targets (local development only)
 *   PORT                     default 4022
 */
// Main-module guard that holds on Windows (C:\...) and POSIX (/home/...) under node and tsx, and through symlinks.
try {
  if (process.argv[1]) process.argv[1] = realpathSync(process.argv[1]);
} catch {
  /* leave argv[1] as given */
}
if (process.argv[1] && import.meta.url === new URL("file:///" + process.argv[1].replace(/\\/g, "/").replace(/^\/+/, "")).href) {
  const strictInt = (name: string, fallback: number, min: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    if (!/^\d{1,9}$/.test(raw.trim()) || Number(raw) < min) {
      throw new Error(`${name} must be a plain integer >= ${min} (got "${raw}")`);
    }
    return Number(raw);
  };
  const index = new SqliteResourceIndex(process.env["DISCOVERY_DB_PATH"] ?? "./discovery.sqlite");
  const port = strictInt("PORT", 4022, 0);
  const app = createDiscoveryApp({
    index,
    trustProxy: process.env["TRUST_PROXY"] === "1",
    trustProxyHops: strictInt("TRUST_PROXY_HOPS", 1, 1),
    allowLocalTargets: process.env["DISCOVERY_ALLOW_LOCAL"] === "1",
  });
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`genesis402-stellar-discovery listening on http://localhost:${info.port}`);
  });
}
