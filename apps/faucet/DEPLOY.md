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

## Refill / recovery

The distributor holds the whole fixed supply (1,000,000,000 G402T, 1,000 per claim). The issuer is locked (master weight 0), so supply can never grow; if the distributor ever runs dry the faucet answers `faucet_empty`. Recovery would mean issuing a new test asset with `npm run setup:testnet` (refuses to run while `testnet-asset.json` or the secrets env file exists).
