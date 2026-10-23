import { isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/**
 * An HTTP dispatcher whose DNS answer is fixed to the addresses the SSRF guard
 * already vetted. The guard resolves a name once; the HTTP client would
 * otherwise resolve it again, and a rebinding domain can answer differently the
 * second time. With this dispatcher the socket is opened to a vetted address
 * while TLS still verifies the original hostname (SNI is unchanged).
 */
export function pinnedDispatcher(addresses: readonly string[]): Dispatcher {
  const pinned = addresses.filter((a) => isIP(a) !== 0);
  if (pinned.length === 0) throw new Error("pinnedDispatcher needs at least one IP address");
  return new Agent({
    connect: {
      lookup: ((_hostname: string, options: { all?: boolean }, cb: LookupCallback) => {
        const records = pinned.map((address) => ({ address, family: isIP(address) }));
        if (options?.all) cb(null, records);
        else cb(null, records[0]!.address, records[0]!.family);
      }) as never,
    },
  });
}

/** Fetch `url` through a dispatcher pinned to `addresses`; works with the global fetch only. */
export function pinnedInit(init: RequestInit, addresses: readonly string[]): RequestInit {
  return { ...init, dispatcher: pinnedDispatcher(addresses) } as RequestInit;
}
