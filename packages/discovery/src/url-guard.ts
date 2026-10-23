import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Resolver = (hostname: string) => Promise<string[]>;

export interface GuardOptions {
  /** DNS resolver; injectable for tests. Default: node:dns lookup, all records. */
  resolve?: Resolver;
  /** Permit plain http:// targets (local development only). */
  allowHttp?: boolean;
  /** Permit loopback and private ranges (local development only). */
  allowPrivate?: boolean;
}

export class TargetNotAllowedError extends Error {
  readonly code = "target_not_allowed" as const;
  constructor(message: string) {
    super(message);
    this.name = "TargetNotAllowedError";
  }
}

const defaultResolver: Resolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

/**
 * SSRF guard for every outbound crawl request. Rejects non-https URLs,
 * embedded credentials, and any host that is, or resolves to, a loopback,
 * private (RFC 1918), shared (100.64/10), link-local (incl. cloud metadata
 * 169.254.169.254), unique-local, multicast, unspecified, documentation,
 * or v4-embedded (mapped, compatible, SIIT, 6to4, NAT64) private address.
 * Every address a hostname resolves to must pass.
 *
 * Returns the vetted addresses so the caller can pin the connection to them
 * (see `pinnedDispatcher`), closing the window between this check and the
 * HTTP client's own DNS lookup (rebinding).
 */
export async function resolveSafeTarget(url: string, opts: GuardOptions = {}): Promise<string[]> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new TargetNotAllowedError("not a URL");
  }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) {
    throw new TargetNotAllowedError(`scheme ${u.protocol} not allowed`);
  }
  if (u.username || u.password) throw new TargetNotAllowedError("credentials in URL");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new TargetNotAllowedError("empty host");

  const literal = isIP(host) !== 0;
  if (!opts.allowPrivate && !literal) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
      throw new TargetNotAllowedError("local hostname");
    }
  }
  const addresses = literal ? [host] : await (opts.resolve ?? defaultResolver)(host).catch(() => []);
  if (addresses.length === 0) throw new TargetNotAllowedError("host does not resolve");
  if (!opts.allowPrivate) {
    for (const a of addresses) {
      if (!isPublicAddress(a)) throw new TargetNotAllowedError("resolves to a non-public address");
    }
  }
  return addresses;
}

export async function assertSafeTarget(url: string, opts: GuardOptions = {}): Promise<void> {
  await resolveSafeTarget(url, opts);
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) return isPublicV4(address);
  if (v === 6) return isPublicV6(address);
  return false;
}

function isPublicV4(a: string): boolean {
  const p = a.split(".").map(Number) as [number, number, number, number];
  const [b0, b1] = p;
  if (b0 === 0) return false; // 0.0.0.0/8 unspecified / "this network"
  if (b0 === 10) return false; // RFC 1918
  if (b0 === 127) return false; // loopback
  if (b0 === 169 && b1 === 254) return false; // link-local incl. 169.254.169.254 metadata
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return false; // RFC 1918
  if (b0 === 192 && b1 === 168) return false; // RFC 1918
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return false; // shared address space (CGNAT)
  if (b0 === 192 && b1 === 0 && p[2] === 0) return false; // IETF protocol assignments
  if (b0 === 192 && b1 === 0 && p[2] === 2) return false; // TEST-NET-1
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return false; // benchmarking
  if (b0 === 198 && b1 === 51 && p[2] === 100) return false; // TEST-NET-2
  if (b0 === 203 && b1 === 0 && p[2] === 113) return false; // TEST-NET-3
  if (b0 >= 224) return false; // multicast and reserved, incl. 255.255.255.255
  return true;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function isPublicV6(a: string): boolean {
  const lower = a.toLowerCase();
  // Dotted-quad tails (::ffff:a.b.c.d, ::a.b.c.d, ::ffff:0:a.b.c.d): judge the embedded v4 and the prefix.
  const dotted = /^(.*):(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) {
    const prefix = expandV6(`${dotted[1]}:0:0`);
    if (!prefix) return false;
    const [g0, g1, g2, g3, g4, g5] = prefix;
    const embeddedOk = isPublicV4(dotted[2]!);
    const zero4 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
    if (zero4 && g4 === 0 && g5 === 0) return false; // ::a.b.c.d v4-compatible (deprecated): never public
    if (zero4 && g4 === 0 && g5 === 0xffff) return embeddedOk; // ::ffff:a.b.c.d mapped
    if (zero4 && g4 === 0xffff && g5 === 0) return embeddedOk; // ::ffff:0:a.b.c.d SIIT
    return embeddedOk && isPublicV6Groups(prefix);
  }
  const groups = expandV6(lower);
  if (!groups) return false;
  return isPublicV6Groups(groups);
}

function isPublicV6Groups(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const zero4 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  if (zero4 && g4 === 0 && g5 === 0) {
    // ::, ::1, and ::a.b.c.d (v4-compatible) in hex form: all non-public.
    return false;
  }
  if (zero4 && g4 === 0 && g5 === 0xffff) return isPublicV4(v4FromGroups(g6, g7)); // mapped
  if (zero4 && g4 === 0xffff && g5 === 0) return isPublicV4(v4FromGroups(g6, g7)); // SIIT
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique-local (incl. fd00:ec2::254)
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2001 && g1 === 0 && g2 === 0) return false; // Teredo-ish 2001:0::/32 reserved
  if (g0 === 0x2002) return isPublicV4(v4FromGroups(g1, g2)); // 6to4
  if (g0 === 0x0064 && g1 === 0xff9b) {
    if (g2 === 1) return false; // 64:ff9b:1::/48 local-use NAT64
    return isPublicV4(v4FromGroups(g6, g7)); // 64:ff9b::/96 well-known NAT64
  }
  return true;
}

function expandV6(a: string): number[] | undefined {
  const [head, tail, extra] = a.split("::");
  if (extra !== undefined) return undefined;
  const parse = (s: string | undefined) =>
    s ? s.split(":").filter(Boolean).map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)) : [];
  const h = parse(head);
  const t = tail === undefined ? [] : parse(tail);
  if (tail === undefined && h.length !== 8) return undefined;
  const fill = 8 - h.length - t.length;
  if (fill < 0) return undefined;
  const groups = [...h, ...Array<number>(fill).fill(0), ...t];
  return groups.some((g) => Number.isNaN(g)) ? undefined : groups;
}
