export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  /** Decides whether an error is worth retrying. Default: transport errors and HTTP 429/5xx. */
  isTransient?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The public SDF testnet RPC sits behind Cloudflare and intermittently answers
 * 520/502/503. Those are safe to retry for reads and simulations; the caller
 * decides whether a write is idempotent (Stellar's sendTransaction is: the
 * same envelope yields the same hash, and a repeat is reported as DUPLICATE).
 */
export function isTransientError(err: unknown): boolean {
  const e = err as { response?: { status?: number }; status?: number; code?: string; message?: string };
  const status = e?.response?.status ?? e?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  if (e?.code && /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ERR_NETWORK|ERR_BAD_RESPONSE|UND_ERR/.test(e.code)) {
    return true;
  }
  // "Cannot convert undefined or null to object" is what the SDK's JSON-RPC layer throws when a
  // proxy answers with a non-JSON (HTML error) body; treat it as a bad gateway.
  return (
    typeof e?.message === "string" &&
    /\b(5\d\d|timeout|socket hang up|fetch failed)\b|Cannot convert undefined or null to object/i.test(e.message)
  );
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 500;
  const isTransient = opts.isTransient ?? isTransientError;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isTransient(err)) throw err;
      await sleep(baseMs * 2 ** i);
    }
  }
  throw lastErr;
}
