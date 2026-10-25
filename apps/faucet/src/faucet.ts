import { Account, Asset, Keypair, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk/base";
import { checkAddress } from "./address.js";
import { MSG, humanDuration } from "./messages.js";
import type { ClaimLimiter, LimitScope } from "./ratelimit.js";

/** Fixed server-side. Nothing in a request can change the amount, asset, source or destination (S1). */
export const G402T_CLAIM_AMOUNT = "1000";
/** What Friendbot gives a new testnet account. Display only; Friendbot decides. */
export const XLM_FRIENDBOT_AMOUNT = "10000";

const MAX_BODY_BYTES = 2048;
const FEE_STROOPS = "1000";
const SEQ_RETRIES = 3;

export interface FaucetConfig {
  networkPassphrase: string;
  horizonUrl: string;
  friendbotUrl: string;
  explorerTxBase: string;
  asset: { code: string; issuer: string; sac: string };
  distributor: string;
  xlmSac: string;
  usdc: { sac: string; faucetUrl: string };
}

export interface FaucetDeps {
  config: FaucetConfig;
  limiter: ClaimLimiter;
  fetch: typeof fetch;
  /** The distributor's secret seed. Read once into a Keypair; never logged, never returned. */
  distributorSecret: string | undefined;
  now: () => number;
  log: (line: string) => void;
}

type Json = Record<string, unknown>;

class HorizonDown extends Error {}

function reply(status: number, body: Json, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

function fail(status: number, error: string, message: string, more: Json = {}, headers: Record<string, string> = {}) {
  return reply(status, { ok: false, error, message, ...more }, headers);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Decimal string with up to 7 places -> stroops. Horizon always sends 7 places. */
function stroops(amount: string): bigint {
  const [whole = "0", frac = ""] = amount.split(".");
  return BigInt(whole) * 10_000_000n + BigInt((frac + "0000000").slice(0, 7));
}

interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
}
interface HorizonAccount {
  id: string;
  sequence: string;
  balances: HorizonBalance[];
}

function loadDistributorKey(secret: string | undefined, expected: string): Keypair | null {
  if (!secret) return null;
  try {
    const kp = Keypair.fromSecret(secret.trim());
    return kp.publicKey() === expected ? kp : null;
  } catch {
    return null;
  }
}

export function createFaucet(deps: FaucetDeps) {
  const { config, limiter, now, log } = deps;
  const doFetch = deps.fetch;
  const asset = new Asset(config.asset.code, config.asset.issuer);
  const signer = loadDistributorKey(deps.distributorSecret, config.distributor);
  if (deps.distributorSecret && !signer) log("faucet: distributor secret is set but does not match the published distributor");

  async function loadAccount(id: string): Promise<HorizonAccount | null> {
    let res: Response;
    try {
      res = await doFetch(`${config.horizonUrl}/accounts/${encodeURIComponent(id)}`, {
        headers: { accept: "application/json" },
      });
    } catch {
      throw new HorizonDown("horizon fetch failed");
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new HorizonDown(`horizon HTTP ${res.status}`);
    return (await res.json()) as HorizonAccount;
  }

  function trustline(acct: HorizonAccount): HorizonBalance | undefined {
    return acct.balances.find((b) => b.asset_code === config.asset.code && b.asset_issuer === config.asset.issuer);
  }

  type SubmitOutcome =
    | { kind: "ok"; hash: string }
    | { kind: "rejected"; codes: unknown }
    | { kind: "pending"; hash: string }
    | { kind: "not_sent"; status: number }
    | { kind: "bad_seq" };

  /**
   * Called once when the submit outcome is unknown (504, network error). Horizon knows a
   * transaction only after it is in a ledger, so 404 here still means "unknown", not "not sent".
   */
  async function lookupTransaction(hash: string): Promise<"applied" | "failed" | "unknown"> {
    try {
      const res = await doFetch(`${config.horizonUrl}/transactions/${hash}`, { headers: { accept: "application/json" } });
      if (!res.ok) return "unknown";
      const body = (await res.json().catch(() => null)) as { successful?: unknown } | null;
      if (body?.successful === true) return "applied";
      if (body?.successful === false) return "failed";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  async function submitPayment(distributorAcct: HorizonAccount, destination: string): Promise<SubmitOutcome> {
    if (!signer) throw new Error("unreachable: no signer");
    const tx = new TransactionBuilder(new Account(config.distributor, distributorAcct.sequence), {
      fee: FEE_STROOPS,
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(Operation.payment({ destination, asset, amount: G402T_CLAIM_AMOUNT }))
      .addMemo(Memo.text("genesis402 faucet"))
      .setTimeout(60)
      .build();
    tx.sign(signer);
    const hash = toHex(tx.hash());
    let res: Response;
    try {
      res = await doFetch(`${config.horizonUrl}/transactions`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ tx: tx.toXDR() }).toString(),
      });
    } catch {
      // The request may or may not have reached Horizon: treat as unknown, never as "nothing sent".
      return settleUnknown(hash);
    }
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { hash?: string };
      return { kind: "ok", hash: body.hash ?? hash };
    }
    if (res.status === 400) {
      const body = (await res.json().catch(() => ({}))) as { extras?: { result_codes?: { transaction?: string } } };
      const codes = body.extras?.result_codes;
      if (codes?.transaction === "tx_bad_seq") return { kind: "bad_seq" };
      return { kind: "rejected", codes: codes ?? null };
    }
    // 429 (rate limited) and 503 (busy): Horizon refused the request before it reached the network.
    if (res.status === 429 || res.status === 503) return { kind: "not_sent", status: res.status };
    // 504 and other gateway errors: the transaction may still be applied.
    return settleUnknown(hash);
  }

  async function settleUnknown(hash: string): Promise<SubmitOutcome> {
    const seen = await lookupTransaction(hash);
    if (seen === "applied") return { kind: "ok", hash };
    if (seen === "failed") return { kind: "rejected", codes: { transaction: "tx_failed" } };
    return { kind: "pending", hash };
  }

  async function readAddress(request: Request): Promise<{ address: string } | Response> {
    const ctype = request.headers.get("content-type") ?? "";
    if (!/^application\/json\b/i.test(ctype)) return fail(415, "unsupported_media_type", MSG.needJson);
    const declared = request.headers.get("content-length");
    if (declared !== null && !(Number(declared) <= MAX_BODY_BYTES)) return fail(413, "too_large", MSG.tooLarge);
    const text = await readCapped(request, MAX_BODY_BYTES);
    if (text === null) return fail(413, "too_large", MSG.tooLarge);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, "bad_json", MSG.badJson);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return fail(400, "bad_json", MSG.badJson);
    // Only `address` is read. Every other field is ignored by construction (S1).
    const check = checkAddress((body as { address?: unknown }).address);
    if (!check.ok) return fail(400, check.code, check.message);
    return { address: check.address };
  }

  /** Reads at most `max` bytes of the body; returns null (and stops reading) once it is longer. */
  async function readCapped(request: Request, max: number): Promise<string | null> {
    if (!request.body) return "";
    const reader = request.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
    const all = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.byteLength;
    }
    return new TextDecoder().decode(all);
  }

  function clientIp(request: Request): string {
    return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  }

  function rateLimited(what: string, scope: LimitScope, retryAfterSec: number): Response {
    return fail(
      429,
      "rate_limited",
      MSG.rateLimited(what, scope, humanDuration(retryAfterSec)),
      { scope, retryAfterSec },
      { "retry-after": String(retryAfterSec) },
    );
  }

  async function claimXlm(request: Request): Promise<Response> {
    const parsed = await readAddress(request);
    if (parsed instanceof Response) return parsed;
    const { address } = parsed;
    const slot = await limiter.reserve("xlm", address, clientIp(request), now());
    if (!slot.ok) return rateLimited("test XLM", slot.scope, slot.retryAfterSec);
    let res: Response;
    try {
      res = await doFetch(`${config.friendbotUrl}/?addr=${encodeURIComponent(address)}`);
    } catch {
      await slot.release();
      log(`xlm: friendbot unreachable for ${address}`);
      return fail(502, "friendbot_unavailable", MSG.friendbotUnavailable);
    }
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { hash?: string };
      const hash = typeof body.hash === "string" ? body.hash : null;
      log(`xlm: funded ${address} tx ${hash ?? "?"}`);
      return reply(200, {
        ok: true,
        token: "XLM",
        amount: XLM_FRIENDBOT_AMOUNT,
        address,
        hash,
        explorer: hash ? `${config.explorerTxBase}${hash}` : null,
      });
    }
    await slot.release();
    if (res.status === 400) {
      log(`xlm: ${address} already funded`);
      return fail(409, "already_funded", MSG.alreadyFunded);
    }
    log(`xlm: friendbot HTTP ${res.status} for ${address}`);
    return fail(502, "friendbot_unavailable", MSG.friendbotUnavailable);
  }

  async function claimG402t(request: Request): Promise<Response> {
    const parsed = await readAddress(request);
    if (parsed instanceof Response) return parsed;
    const { address } = parsed;
    if (!signer) return fail(503, "not_configured", MSG.notConfigured);
    const slot = await limiter.reserve("g402t", address, clientIp(request), now());
    if (!slot.ok) return rateLimited(`${Number(G402T_CLAIM_AMOUNT).toLocaleString("en-US")} ${config.asset.code}`, slot.scope, slot.retryAfterSec);

    try {
      const dest = await loadAccount(address);
      if (!dest) {
        await slot.release();
        return fail(404, "account_not_found", MSG.accountNotFound);
      }
      const line = trustline(dest);
      if (!line) {
        await slot.release();
        return fail(409, "no_trustline", MSG.noTrustline(config.asset.code, config.asset.issuer), {
          fix: { operation: "change_trust", assetCode: config.asset.code, assetIssuer: config.asset.issuer, account: address },
        });
      }
      const room = stroops(line.limit ?? "922337203685.4775807") - stroops(line.balance);
      if (room < stroops(G402T_CLAIM_AMOUNT)) {
        await slot.release();
        return fail(409, "trustline_full", MSG.trustlineFull(config.asset.code));
      }

      for (let attempt = 1; attempt <= SEQ_RETRIES; attempt++) {
        const dist = await loadAccount(config.distributor);
        const held = dist ? trustline(dist) : undefined;
        if (!dist || !held || stroops(held.balance) < stroops(G402T_CLAIM_AMOUNT)) {
          await slot.release();
          log("g402t: distributor empty or missing");
          return fail(503, "faucet_empty", MSG.faucetEmpty);
        }
        const outcome = await submitPayment(dist, address);
        if (outcome.kind === "ok") {
          log(`g402t: paid ${G402T_CLAIM_AMOUNT} to ${address} tx ${outcome.hash}`);
          return reply(200, {
            ok: true,
            token: config.asset.code,
            amount: G402T_CLAIM_AMOUNT,
            address,
            hash: outcome.hash,
            explorer: `${config.explorerTxBase}${outcome.hash}`,
          });
        }
        if (outcome.kind === "pending") {
          // Keep the slot: the payment may land, and a retry could pay twice.
          log(`g402t: submit outcome unknown for ${address} tx ${outcome.hash}`);
          return fail(504, "submit_pending", MSG.submitPending, {
            hash: outcome.hash,
            explorer: `${config.explorerTxBase}${outcome.hash}`,
          });
        }
        if (outcome.kind === "not_sent") {
          await slot.release();
          log(`g402t: horizon HTTP ${outcome.status} on submit for ${address}, nothing sent`);
          return fail(503, "horizon_busy", MSG.horizonBusy, {}, { "retry-after": "30" });
        }
        if (outcome.kind === "rejected") {
          await slot.release();
          log(`g402t: submit rejected for ${address} codes ${JSON.stringify(outcome.codes)}`);
          return fail(502, "submit_failed", MSG.submitFailed, { resultCodes: outcome.codes });
        }
        log(`g402t: tx_bad_seq for ${address}, attempt ${attempt}`);
      }
      await slot.release();
      return fail(502, "submit_failed", MSG.submitFailed, { resultCodes: { transaction: "tx_bad_seq" } });
    } catch (err) {
      await slot.release();
      if (err instanceof HorizonDown) {
        log(`g402t: ${err.message} for ${address}`);
        return fail(502, "horizon_unavailable", MSG.horizonUnavailable);
      }
      log(`g402t: internal error for ${address}: ${(err as Error).name}`);
      return fail(500, "internal", MSG.internal);
    }
  }

  function info(): Response {
    return reply(200, {
      ok: true,
      network: "stellar:testnet",
      asset: config.asset,
      distributor: config.distributor,
      claimAmount: G402T_CLAIM_AMOUNT,
      xlm: { amount: XLM_FRIENDBOT_AMOUNT, sac: config.xlmSac },
      usdc: config.usdc,
      horizonUrl: config.horizonUrl,
      networkPassphrase: config.networkPassphrase,
      explorerTxBase: config.explorerTxBase,
      g402tReady: signer !== null,
    });
  }

  const routes: Record<string, { method: string; run: (r: Request) => Promise<Response> | Response }> = {
    "/api/info": { method: "GET", run: info },
    "/api/claim/xlm": { method: "POST", run: claimXlm },
    "/api/claim/g402t": { method: "POST", run: claimG402t },
  };

  return {
    async handle(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      const route = routes[pathname];
      if (!route) return fail(404, "not_found", MSG.notFound);
      if (request.method !== route.method) return fail(405, "method_not_allowed", MSG.methodNotAllowed, {}, { allow: route.method });
      try {
        return await route.run(request);
      } catch (err) {
        log(`faucet: unhandled ${(err as Error).name} on ${pathname}`);
        return fail(500, "internal", MSG.internal);
      }
    },
  };
}
