import { serve } from "@hono/node-server";
import { createDiscoveryApp } from "./app.js";
import { SqliteResourceIndex } from "./index-store.js";

/**
 * Standalone discovery index.
 *   DISCOVERY_DB_PATH   SQLite file (default ./discovery.sqlite)
 *   PORT                default 4022
 */
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const index = new SqliteResourceIndex(process.env["DISCOVERY_DB_PATH"] ?? "./discovery.sqlite");
  const port = Number(process.env["PORT"] ?? 4022);
  serve({ fetch: createDiscoveryApp({ index }).fetch, port }, (info) => {
    console.log(`genesis402-stellar-discovery listening on http://localhost:${info.port}`);
  });
}
