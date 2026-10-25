// Opt-in: FAUCET_TESTNET_TESTS=1 npm test
// Claims test XLM and 1,000 G402T for a brand-new testnet account through the real handlers,
// real Friendbot and real Horizon. Reads the distributor secret from the secrets env file
// (or DISTRIBUTOR_SECRET in the environment) and never prints it.
import { existsSync, readFileSync } from "node:fs";
import { Account, Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk/base";
import { describe, expect, it } from "vitest";
import asset from "../testnet-asset.json";
import { createFaucet } from "../src/faucet.js";
import { ClaimLimiter } from "../src/ratelimit.js";
import { sqliteD1 } from "./sqlite-d1.js";

const ENABLED = process.env.FAUCET_TESTNET_TESTS === "1";
const SECRET_FILE = process.env.FAUCET_SECRET_FILE ?? "C:/Users/Kevan/.unykorn/secrets/g402-faucet-testnet.env";

function distributorSecret(): string | undefined {
  if (process.env.DISTRIBUTOR_SECRET) return process.env.DISTRIBUTOR_SECRET;
  if (!existsSync(SECRET_FILE)) return undefined;
  const line = readFileSync(SECRET_FILE, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("DISTRIBUTOR_SECRET="));
  return line?.slice("DISTRIBUTOR_SECRET=".length).trim();
}

async function horizonAccount(id: string): Promise<{ sequence: string; balances: Array<Record<string, string>> }> {
  for (let i = 0; i < 15; i++) {
    const res = await fetch(`${asset.horizonUrl}/accounts/${id}`);
    if (res.ok) return (await res.json()) as never;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`account ${id} not visible on Horizon`);
}

describe.skipIf(!ENABLED)("testnet: claim to a fresh account", () => {
  it("funds with XLM, adds a trustline, receives exactly 1,000 G402T", async () => {
    const faucet = createFaucet({
      config: asset,
      limiter: new ClaimLimiter(sqliteD1(), { windowMs: 86_400_000, perAddress: 1, perIp: 1 }),
      fetch: (i, init) => fetch(i, init),
      distributorSecret: distributorSecret(),
      now: () => Date.now(),
      log: () => {},
    });
    const kp = Keypair.random();
    const call = async (token: string) => {
      const res = await faucet.handle(
        new Request(`https://faucet.test/api/claim/${token}`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "integration" },
          body: JSON.stringify({ address: kp.publicKey() }),
        }),
      );
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };

    const xlm = await call("xlm");
    expect(xlm.status, JSON.stringify(xlm.body)).toBe(200);
    const acct = await horizonAccount(kp.publicKey());

    const noTrust = await call("g402t");
    expect(noTrust.status).toBe(409);
    expect(noTrust.body.error).toBe("no_trustline");

    const tx = new TransactionBuilder(new Account(kp.publicKey(), acct.sequence), {
      fee: "1000",
      networkPassphrase: asset.networkPassphrase,
    })
      .addOperation(Operation.changeTrust({ asset: new Asset(asset.asset.code, asset.asset.issuer) }))
      .setTimeout(60)
      .build();
    tx.sign(kp);
    const trust = await fetch(`${asset.horizonUrl}/transactions`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tx: tx.toXDR() }).toString(),
    });
    expect(trust.ok).toBe(true);

    const g = await call("g402t");
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.hash).toMatch(/^[0-9a-f]{64}$/);
    console.log(`testnet claim tx: ${g.body.explorer}`);

    const after = await horizonAccount(kp.publicKey());
    const line = after.balances.find((b) => b.asset_code === asset.asset.code && b.asset_issuer === asset.asset.issuer);
    expect(line?.balance).toBe("1000.0000000");

    const again = await call("g402t");
    expect(again.status).toBe(429);
  });
});
