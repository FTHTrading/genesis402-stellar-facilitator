# Genesis402 testnet faucet: deploy and rollback

Status: NOT DEPLOYED. Deploying creates the public hostname `faucet.genesis402.com` and waits for Kevan's "go faucet".
Everything here is Stellar testnet. Testnet only. These tokens have no value.

## What gets deployed

| Piece | Where |
|---|---|
| Worker `g402-faucet` (`src/worker.ts`) | Cloudflare Workers, custom domain `faucet.genesis402.com` (wrangler creates the DNS record on deploy) |
| Static page (`public/`, plus `public/app.js` built by `build.mjs`) | Workers static assets, same Worker |
| Rate-limit table `claim_counters` | D1 database `g402-faucet` (table is created by the Worker on first request) |
| Distributor secret | Worker secret `DISTRIBUTOR_SECRET`, loaded from `C:\Users\Kevan\.unykorn\secrets\g402-faucet-testnet.env` |
| Public asset data | `testnet-asset.json` (committed; no secrets) |

## Run locally

```powershell
cd C:\Users\Kevan\dev\blockchain\g402-faucet\apps\faucet
npm ci
npm test
npx wrangler dev --port 8787 --env-file C:/Users/Kevan/.unykorn/secrets/g402-faucet-testnet.env
# open http://127.0.0.1:8787
```

Local rate limits live in `.wrangler/state`. To clear them between manual tests:

```powershell
npx wrangler d1 execute g402-faucet --local --command "DELETE FROM claim_counters"
```

## Deploy (after "go faucet")

```powershell
cd C:\Users\Kevan\dev\blockchain\g402-faucet\apps\faucet
npm ci
npm test

# 1. Create the D1 database once, then paste the printed database_id into wrangler.toml
#    (replacing 00000000-0000-0000-0000-000000000000).
npx wrangler d1 create g402-faucet

# 2. Dry run: builds the bundle and shows bindings, uploads nothing.
npx wrangler deploy --dry-run

# 3. Deploy the Worker (creates faucet.genesis402.com).
npx wrangler deploy

# 4. Load the distributor secret from the env file. The value is read from the file and is never echoed.
npx wrangler secret bulk C:/Users/Kevan/.unykorn/secrets/g402-faucet-testnet.env
```

Step 4 can run before the custom domain answers; until it runs, `/api/info` reports `"g402tReady": false` and the G402T card says it is not set up, while test XLM works.

## Verify what is served (not the repo)

```powershell
curl.exe -s https://faucet.genesis402.com/api/info
curl.exe -s -o NUL -w "%{http_code}\n" https://faucet.genesis402.com/
curl.exe -s -D - -o NUL https://faucet.genesis402.com/ | findstr /i "content-security-policy"
```

Expected: `g402tReady: true`, asset issuer `GDJIYLQDNCT4QFW7SEBE4KUIQA6KLYHNNUUD2RBOUCLZPYTJSIT6ZSMJ`, SAC `CAO4LRADWFCLUUA7GL6SKD5Z7JMACAVYINF46N7WXRZ2PMXZ5OYJ6FGO`, HTTP 200, CSP header present.
Then claim to a fresh trustlined test address from the page and open the stellar.expert link. Also confirm from a second network that a spoofed `cf-connecting-ip` request header does not change the per-network limit (Cloudflare overwrites that header at the edge; locally it does not).

## Rollback

```powershell
# Back to the previous Worker version (if one exists):
npx wrangler rollback

# Take the faucet off the internet entirely (removes the Worker and its custom domain route):
npx wrangler delete g402-faucet
```

`wrangler delete` does not delete the D1 database or touch testnet balances. To drop the database too: `npx wrangler d1 delete g402-faucet`.
Stopping the G402T side alone: `npx wrangler secret delete DISTRIBUTOR_SECRET` (test XLM keeps working).

## Limits

| Limit | Default | Where |
|---|---|---|
| Claims per address per token | 1 per 24 h | `CLAIMS_PER_ADDRESS` in `wrangler.toml` |
| Claims per network per token (IPv4 /32, IPv6 /64) | 1 per 24 h | `CLAIMS_PER_IP` in `wrangler.toml` |
| G402T claims for the whole faucet | 1,000 per UTC day (1,000,000 G402T) | `globalPerDay` in `src/ratelimit.ts`; `globalLimitsFromEnv()` reads an env var value but `src/worker.ts` does not pass one yet, so the default applies |
| Tries per network per token (counted even when nothing is sent) | 5 per hour | `attemptsPerHour` in `src/ratelimit.ts` |

All four live in the same `claim_counters` D1 table, keys `<token>|a|<address>`, `<token>|i|<network>`, `g402t|g|<YYYY-MM-DD>` and `<token>|t|<network>`.

## Testnet reset

Stellar testnet resets periodically (SDF announces each reset ahead of time). A reset wipes every testnet account, so the G402T issuer, the distributor and both SAC contracts in `testnet-asset.json` stop existing. Symptoms after a reset: G402T claims answer `faucet_empty` (the distributor account is gone) and the stellar.expert links in the page show "account not found".

Recovery:

1. Move the old files aside (the setup script refuses to run while either exists, so nothing is overwritten by accident):
   - `testnet-asset.json` to `testnet-asset.<reset-date>.json`
   - `C:\Users\Kevan\.unykorn\secrets\g402-faucet-testnet.env` to `g402-faucet-testnet.<reset-date>.env` (same folder; do not print it)
2. Re-run `scripts/setup-testnet.ts` (`npm run setup:testnet`). It creates a new issuer, distributor and SAC addresses, writes a new secrets env file and a new `testnet-asset.json`.
3. Check the new `testnet-asset.json` (issuer, distributor, SAC addresses) and commit it. Update the issuer and SAC values listed under "Verify what is served" above.
4. Reload the distributor secret: `npx wrangler secret bulk C:/Users/Kevan/.unykorn/secrets/g402-faucet-testnet.env`.
5. Redeploy so the Worker serves the new `testnet-asset.json`: `npm test`, then `npx wrangler deploy` (after Kevan's go, same as a first deploy).
6. Optional: clear old rate-limit rows with `npx wrangler d1 execute g402-faucet --remote --command "DELETE FROM claim_counters"`.
7. Verify served: `/api/info` shows the new issuer and `g402tReady: true`, and one claim from the page lands on stellar.expert.

## Refill / recovery

The distributor holds the whole fixed supply (1,000,000,000 G402T, 1,000 per claim). The issuer is locked (master weight 0), so supply can never grow; if the distributor ever runs dry the faucet answers `faucet_empty`. Recovery would mean issuing a new test asset with `npm run setup:testnet` (refuses to run while `testnet-asset.json` or the secrets env file exists).
