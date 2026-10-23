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
 * 169.254.169.254), unique-local, multicast, unspecified, or v4-mapped
 * private address. Every address a hostname resolves to must pass.
 */
export async function assertSafeTarget(url: string, opts: GuardOptions = {}): Promise<void> {
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
  if (opts.allowPrivate) return;

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new TargetNotAllowedError("local hostname");
  }
  const addresses = isIP(host) ? [host] : await (opts.resolve ?? defaultResolver)(host).catch(() => []);
  if (addresses.length === 0) throw new TargetNotAllowedError("host does not resolve");
  for (const a of addresses) {
    if (!isPublicAddress(a)) throw new TargetNotAllowedError("resolves to a non-public address");
  }
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
  if (b0 >= 224) return false; // multicast and reserved, incl. 255.255.255.255
  return true;
}

function isPublicV6(a: string): boolean {
  const lower = a.toLowerCase();
  // v4-mapped (::ffff:a.b.c.d) and v4-compatible forms: judge the embedded v4.
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPublicV4(mapped[1]!);
  const mappedHex = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    return isPublicV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const groups = expandV6(lower);
  if (!groups) return false;
  const g0 = groups[0]!;
  const allZeroButLast = groups.slice(0, 7).every((g) => g === 0);
  if (allZeroButLast && (groups[7] === 0 || groups[7] === 1)) return false; // :: and ::1
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique-local (incl. fd00:ec2::254)
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (g0 === 0x2001 && groups[1] === 0x0db8) return false; // documentation
  if (g0 === 0x2002) return isPublicV4(`${groups[1]! >> 8}.${groups[1]! & 255}.${groups[2]! >> 8}.${groups[2]! & 255}`); // 6to4
  if (g0 === 0x0064 && groups[1] === 0xff9b) return isPublicV4(`${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`); // NAT64
  return true;
}

function expandV6(a: string): number[] | undefined {
  const [head, tail] = a.split("::");
  const parse = (s: string | undefined) => (s ? s.split(":").filter(Boolean).map((h) => parseInt(h, 16)) : []);
  const h = parse(head);
  const t = tail === undefined ? [] : parse(tail);
  if (tail === undefined && h.length !== 8) return undefined;
  const fill = 8 - h.length - t.length;
  if (fill < 0) return undefined;
  const groups = [...h, ...Array<number>(fill).fill(0), ...t];
  return groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? undefined : groups;
}
