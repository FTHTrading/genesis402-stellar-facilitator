/** The subset of D1 the limiter uses, so tests can run the same SQL on node:sqlite. */
export interface SqlStatement {
  bind(...params: unknown[]): SqlStatement;
  run(): Promise<{ meta: { changes: number } }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface SqlDb {
  prepare(sql: string): SqlStatement;
  exec(sql: string): Promise<unknown>;
}

/** Default global ceiling: 1,000 G402T claims (1,000,000 G402T) per UTC day. */
export const DEFAULT_G402T_PER_DAY = 1000;
/** Default upstream attempts per IP bucket per endpoint per hour. Never handed back. */
export const DEFAULT_ATTEMPTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface LimiterOptions {
  windowMs: number;
  perAddress: number;
  perIp: number;
  /** Claims per UTC day across all callers, per token. Tokens not listed have no global cap. Default { g402t: 1000 }. */
  globalPerDay?: Partial<Record<string, number>>;
  /** Upstream attempts per IP bucket per token per hour, counted whether or not anything was sent. Default 5. */
  attemptsPerHour?: number;
}

export type LimitScope = "address" | "ip" | "global" | "attempts";

export type Reservation =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; scope: LimitScope; retryAfterSec: number };

/** Reads the global G402T daily ceiling from an env var value; anything not a positive integer means the default. */
export function globalLimitsFromEnv(value: string | undefined): Record<string, number> {
  const n = Number(value);
  return { g402t: Number.isInteger(n) && n > 0 ? n : DEFAULT_G402T_PER_DAY };
}

function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(s)) return null;
  // A trailing dotted IPv4 part counts as the last two groups.
  let tail: number[] = [];
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const parts = v4[2]!.split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    tail = [(parts[0]! << 8) | parts[1]!, (parts[2]! << 8) | parts[3]!];
    s = v4[1]!.endsWith("::") ? v4[1]! : v4[1]!.slice(0, -1);
  }
  if (s.includes(".")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === "" ? [] : h.split(":"));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const want = 8 - tail.length;
  const nums = (gs: string[]) => gs.map((g) => parseInt(g, 16));
  if (halves.length === 1) {
    if (head.length !== want) return null;
    return [...nums(head), ...tail];
  }
  const fill = want - head.length - rest.length;
  if (fill < 1) return null;
  return [...nums(head), ...Array<number>(fill).fill(0), ...nums(rest), ...tail];
}

/**
 * The per-IP bucket. IPv4 is the whole address (/32). IPv6 is cut to its /64,
 * because one customer is normally handed a whole /64. IPv4-mapped IPv6 counts as IPv4.
 * Anything unparseable is used as given, so it still gets a bucket of its own.
 */
export function ipBucket(raw: string): string {
  const ip = raw.trim();
  if (!ip.includes(":")) return ip;
  const g = expandIpv6(ip);
  if (!g) return ip;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS claim_counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL, window_start INTEGER NOT NULL)`;

/*
 * One statement both checks and takes a slot, so concurrent requests cannot
 * both pass the check (S2). D1 runs statements one at a time per database.
 * ?1 key, ?2 now, ?3 now - window, ?4 limit. changes = 1 means a slot was taken.
 * Every counter (address, IP, global day, attempts) is taken with this same statement.
 */
const RESERVE = `INSERT INTO claim_counters (k, n, window_start) VALUES (?1, 1, ?2)
ON CONFLICT(k) DO UPDATE SET
  n = CASE WHEN claim_counters.window_start <= ?3 THEN 1 ELSE claim_counters.n + 1 END,
  window_start = CASE WHEN claim_counters.window_start <= ?3 THEN ?2 ELSE claim_counters.window_start END
WHERE claim_counters.window_start <= ?3 OR claim_counters.n < ?4`;

const RELEASE = `UPDATE claim_counters SET n = n - 1 WHERE k = ?1 AND n > 0`;
const WINDOW_OF = `SELECT window_start FROM claim_counters WHERE k = ?1`;

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class ClaimLimiter {
  private schemaReady: Promise<unknown> | null = null;
  private readonly globalPerDay: Partial<Record<string, number>>;
  private readonly attemptsPerHour: number;

  constructor(
    private readonly db: SqlDb,
    private readonly opts: LimiterOptions,
  ) {
    this.globalPerDay = opts.globalPerDay ?? { g402t: DEFAULT_G402T_PER_DAY };
    this.attemptsPerHour = opts.attemptsPerHour ?? DEFAULT_ATTEMPTS_PER_HOUR;
  }

  private ensureSchema(): Promise<unknown> {
    this.schemaReady ??= this.db.exec(SCHEMA).catch((err) => {
      this.schemaReady = null;
      throw err;
    });
    return this.schemaReady;
  }

  /** windowMs null = the key itself is dated (global day), so the window never rolls over. */
  private async take(key: string, now: number, limit: number, windowMs: number | null): Promise<boolean> {
    const rollover = windowMs === null ? Number.MIN_SAFE_INTEGER : now - windowMs;
    const res = await this.db.prepare(RESERVE).bind(key, now, rollover, limit).run();
    return res.meta.changes === 1;
  }

  private async give(key: string): Promise<void> {
    await this.db.prepare(RELEASE).bind(key).run();
  }

  private async retryAfter(key: string, now: number, windowMs: number): Promise<number> {
    const row = await this.db.prepare(WINDOW_OF).bind(key).first<{ window_start: number }>();
    const start = row ? Number(row.window_start) : now;
    return Math.max(1, Math.ceil((start + windowMs - now) / 1000));
  }

  /**
   * Takes, in order: the address slot, the IP slot, the global day slot (if the token has one),
   * then one attempt. If any is refused, the slots already taken are handed back. The attempt
   * counter is never handed back, so failed outcomes cannot be retried without bound.
   */
  async reserve(token: string, address: string, ip: string, now: number): Promise<Reservation> {
    await this.ensureSchema();
    const bucket = ipBucket(ip);
    const addrKey = `${token}|a|${address}`;
    const ipKey = `${token}|i|${bucket}`;
    const globalLimit = this.globalPerDay[token];
    const globalKey = `${token}|g|${utcDay(now)}`;
    const attemptKey = `${token}|t|${bucket}`;
    const taken: string[] = [];
    const undo = async () => {
      for (const k of [...taken].reverse()) await this.give(k);
    };

    if (!(await this.take(addrKey, now, this.opts.perAddress, this.opts.windowMs))) {
      return { ok: false, scope: "address", retryAfterSec: await this.retryAfter(addrKey, now, this.opts.windowMs) };
    }
    taken.push(addrKey);
    if (!(await this.take(ipKey, now, this.opts.perIp, this.opts.windowMs))) {
      await undo();
      return { ok: false, scope: "ip", retryAfterSec: await this.retryAfter(ipKey, now, this.opts.windowMs) };
    }
    taken.push(ipKey);
    if (globalLimit !== undefined) {
      if (!(await this.take(globalKey, now, globalLimit, null))) {
        await undo();
        const nextMidnight = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
        return { ok: false, scope: "global", retryAfterSec: Math.max(1, Math.ceil((nextMidnight - now) / 1000)) };
      }
      taken.push(globalKey);
    }
    if (!(await this.take(attemptKey, now, this.attemptsPerHour, HOUR_MS))) {
      await undo();
      return { ok: false, scope: "attempts", retryAfterSec: await this.retryAfter(attemptKey, now, HOUR_MS) };
    }

    const held = [...taken];
    let released = false;
    return {
      ok: true,
      release: async () => {
        if (released) return;
        released = true;
        for (const k of held) await this.give(k);
      },
    };
  }
}
