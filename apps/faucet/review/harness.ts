import { Keypair, Networks, StrKey, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk/base";
import { createFaucet, type FaucetConfig } from "../src/faucet.js";
import { ClaimLimiter } from "../src/ratelimit.js";
import { sqliteD1 } from "../test/sqlite-d1.js";

export const DAY = 24 * 60 * 60 * 1000;
export const HORIZON = "https://horizon.review";
export const FRIENDBOT = "https://friendbot.review";
export const issuer = Keypair.random();
export const distributor = Keypair.random();

export const config: FaucetConfig = {
  networkPassphrase: Networks.TESTNET,
  horizonUrl: HORIZON,
  friendbotUrl: FRIENDBOT,
  explorerTxBase: "https://stellar.expert/explorer/testnet/tx/",
  asset: { code: "G402T", issuer: issuer.publicKey(), sac: StrKey.encodeContract(Buffer.alloc(32, 1)) },
  distributor: distributor.publicKey(),
  xlmSac: StrKey.encodeContract(Buffer.alloc(32, 2)),
  usdc: { sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", faucetUrl: "https://faucet.circle.com" },
};

/** Fake Horizon/Friendbot. Every destination account is assumed to exist with a G402T trustline unless listed. */
export class World {
  calls: Array<{ method: string; url: string }> = [];
  logs: string[] = [];
  submitted: Transaction[] = [];
  submitResponses: Array<{ status: number; body: unknown }> = [];
  friendbot: { status: number; body: unknown } = { status: 200, body: { hash: "f".repeat(64) } };
  noTrustline = new Set<string>();
  accountResponse: ((id: string) => Response | null) | null = null;
  seq = 100n;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    this.calls.push({ method, url });
    if (url.startsWith(FRIENDBOT)) return json(this.friendbot.body, this.friendbot.status);
    if (url.startsWith(`${HORIZON}/accounts/`)) {
      const id = decodeURIComponent(url.slice(`${HORIZON}/accounts/`.length));
      const forced = this.accountResponse?.(id);
      if (forced) return forced;
      const native = { asset_type: "native", balance: "10000.0000000" };
      const line = {
        asset_type: "credit_alphanum12",
        asset_code: "G402T",
        asset_issuer: issuer.publicKey(),
        balance: id === distributor.publicKey() ? "1000000000.0000000" : "0.0000000",
        limit: "922337203685.4775807",
      };
      return json({ id, sequence: String(this.seq), balances: this.noTrustline.has(id) ? [native] : [native, line] });
    }
    if (url === `${HORIZON}/transactions` && method === "POST") {
      const xdr = new URLSearchParams(String(init?.body ?? "")).get("tx") ?? "";
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
      const next = this.submitResponses.shift();
      if (next) return json(next.body, next.status);
      this.submitted.push(tx);
      this.seq += 1n;
      return json({ hash: Buffer.from(tx.hash()).toString("hex") });
    }
    return json({ error: "unexpected" }, 599);
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function makeFaucet(world: World, clock: { t: number }, opts: { secret?: string } = {}) {
  const limiter = new ClaimLimiter(sqliteD1(), { windowMs: DAY, perAddress: 1, perIp: 1 });
  return createFaucet({
    config,
    limiter,
    fetch: world.fetch as typeof fetch,
    distributorSecret: "secret" in opts ? opts.secret : distributor.secret(),
    now: () => clock.t,
    log: (l) => world.logs.push(l),
  });
}

export async function call(
  faucet: ReturnType<typeof createFaucet>,
  path: string,
  body: BodyInit | null,
  headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
  method = "POST",
) {
  const res = await faucet.handle(new Request(`https://faucet.review${path}`, { method, headers, body }));
  const text = await res.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, text, body: parsed, headers: res.headers };
}

export const addr = () => Keypair.random().publicKey();
