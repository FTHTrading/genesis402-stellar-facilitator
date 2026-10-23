import { DatabaseSync } from "node:sqlite";
import { ResourceRecordSchema, type ResourceQuery, type ResourceRecord } from "./schema.js";

export interface SellerRow {
  manifest_url: string;
  seller_origin: string;
  last_crawled_at: string;
  listed: number;
  skipped: number;
}

export interface ResourceIndex {
  upsert(record: ResourceRecord): void;
  query(q: ResourceQuery): ResourceRecord[];
  count(): number;
  recordCrawl(row: SellerRow): void;
  sellers(): SellerRow[];
}

/** SQLite-backed index. Amounts are stored as 20-digit zero-padded text so lexical order equals numeric order. */
export class SqliteResourceIndex implements ResourceIndex {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        seller_origin TEXT NOT NULL,
        network TEXT NOT NULL,
        amount_key TEXT NOT NULL,
        category TEXT,
        name TEXT NOT NULL,
        title TEXT NOT NULL,
        what_you_get TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS resources_network ON resources(network, amount_key);
      CREATE TABLE IF NOT EXISTS sellers (
        manifest_url TEXT PRIMARY KEY,
        seller_origin TEXT NOT NULL,
        last_crawled_at TEXT NOT NULL,
        listed INTEGER NOT NULL,
        skipped INTEGER NOT NULL
      );
    `);
  }

  upsert(record: ResourceRecord): void {
    const existing = this.db
      .prepare("SELECT first_seen FROM resources WHERE id = ?")
      .get(record.id) as { first_seen: string } | undefined;
    const merged: ResourceRecord = { ...record, first_seen: existing?.first_seen ?? record.first_seen };
    this.db
      .prepare(
        `INSERT INTO resources (id, seller_origin, network, amount_key, category, name, title, what_you_get, first_seen, record)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           seller_origin = excluded.seller_origin, network = excluded.network, amount_key = excluded.amount_key,
           category = excluded.category, name = excluded.name, title = excluded.title,
           what_you_get = excluded.what_you_get, record = excluded.record`,
      )
      .run(
        merged.id,
        merged.seller_origin,
        merged.network,
        amountKey(merged.amount),
        merged.category ?? null,
        merged.name,
        merged.title,
        merged.what_you_get,
        merged.first_seen,
        JSON.stringify(merged),
      );
  }

  query(q: ResourceQuery): ResourceRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (q.network) {
      where.push("network = ?");
      params.push(q.network);
    }
    if (q.maxAmount !== undefined) {
      where.push("amount_key <= ?");
      params.push(amountKey(q.maxAmount));
    }
    if (q.category) {
      where.push("category = ?");
      params.push(q.category);
    }
    if (q.seller) {
      where.push("seller_origin = ?");
      params.push(q.seller);
    }
    if (q.q) {
      where.push("(lower(name) LIKE ? OR lower(title) LIKE ? OR lower(what_you_get) LIKE ?)");
      const like = `%${q.q.toLowerCase()}%`;
      params.push(like, like, like);
    }
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    const sql = `SELECT record FROM resources ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY amount_key ASC, name ASC LIMIT ${limit}`;
    const rows = this.db.prepare(sql).all(...params) as Array<{ record: string }>;
    return rows.map((r) => ResourceRecordSchema.parse(JSON.parse(r.record)));
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number };
    return row.n;
  }

  recordCrawl(row: SellerRow): void {
    this.db
      .prepare(
        `INSERT INTO sellers (manifest_url, seller_origin, last_crawled_at, listed, skipped) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(manifest_url) DO UPDATE SET seller_origin = excluded.seller_origin,
           last_crawled_at = excluded.last_crawled_at, listed = excluded.listed, skipped = excluded.skipped`,
      )
      .run(row.manifest_url, row.seller_origin, row.last_crawled_at, row.listed, row.skipped);
  }

  sellers(): SellerRow[] {
    return this.db.prepare("SELECT * FROM sellers ORDER BY manifest_url").all() as unknown as SellerRow[];
  }

  close(): void {
    this.db.close();
  }
}

function amountKey(amount: string): string {
  if (!/^\d+$/.test(amount)) throw new Error(`amount must be an integer string, got ${amount}`);
  return amount.padStart(24, "0");
}
