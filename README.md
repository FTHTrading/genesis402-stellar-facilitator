# Genesis402 Stellar Facilitator

Open-source [x402](https://www.x402.org) payment facilitator for Stellar, with a Bazaar-style discovery index and a seller SDK. A buyer signs one Soroban authorization entry for a SEP-41 `transfer(from, to, amount)` on the USDC Stellar Asset Contract; the facilitator checks it, re-simulates it with its own account as transaction source, pays the network fee, submits, and returns a settlement receipt. The facilitator never holds buyer funds: it is never `from`, never `to`, and never an authorizer on the transfer. Non-custodial by construction.

Apache-2.0. Copyright 2026 UnyKorn LLC (Wyoming). Contact: kevan@unykorn.org.

## State of each part (read this first)

| Part | Path | State |
|---|---|---|
| Facilitator: static verification of the x402 `exact` Stellar payload (amount, destination, asset, expiry window, local Ed25519 check of the auth entry, nonce replay) | `packages/facilitator/src/verify.ts` | **TESTED** (unit, no network) |
| Facilitator: simulate with facilitator as source, transfer-event check, fee ceiling, submit, wait for inclusion | `packages/facilitator/src/facilitator.ts`, `chain.ts` | **REAL on testnet** (one settled payment per demo run, see below) |
| Facilitator HTTP API `/supported`, `/verify`, `/settle`, `/health` | `packages/facilitator/src/app.ts` | **TESTED**; runs in-process in the demo. **NOT DEPLOYED** to any public host |
| Seller SDK: 402 quote, verify+settle through the facilitator, Hono middleware, `/.well-known/x402` manifest | `packages/seller-sdk` | **TESTED** |
| Discovery index: crawler that lists a resource only after a real 402, SSRF guard with DNS pinning, SQLite index, `GET /discovery/resources`, queued and rate-limited registration | `packages/discovery` | **TESTED**; **NOT DEPLOYED** |
| Reference seller (two paid routes + manifest) and payer demo | `examples/` | **REAL on testnet** when run with `npm run demo:testnet` |
| Payment asset in the demo | `TUSDC`, issued per run by a throwaway testnet issuer | **DEMO**. Not USDC, no value. Circle's testnet USDC works unchanged if the payer holds some (see below) |
| Stellar mainnet (`stellar:pubnet`) | constants only | **NOT DEPLOYED**, out of scope for T1 |
| Soroban settlement contract `x402-settle` (payer-authorized `settle`, on-chain nonce, flat fee split, admin-less) | `contracts/x402-settle` on branch `t2/rebase-main` (not on `main` at this commit) | **TESTED on testnet** at `CA5LF4WBEXMFGX4BQCSLVEXVV6U3AUIQ55KNTSIQVD3HDEXAEEWFE5BC` (see `contracts/x402-settle/DEPLOY-TESTNET.md`); **NOT DEPLOYED to mainnet**; **not yet wired to the facilitator** (`/settle` still transfers through the token contract directly; the switch is designed in `docs/T2-contract-path.md`) |

## Run it in 5 minutes

Requirements: Node 24 (uses `node:sqlite`), npm, outbound HTTPS to `friendbot.stellar.org`, `horizon-testnet.stellar.org`, `soroban-testnet.stellar.org`.

```bash
git clone https://github.com/FTHTrading/genesis402-stellar-facilitator
cd genesis402-stellar-facilitator
npm ci
npm test            # unit tests, no network
npm run demo:testnet
```

The demo:

1. generates four testnet keypairs (facilitator, payer, seller, issuer) into `examples/payer/demo-keys.json` (gitignored; reused on the next run) and funds them with friendbot;
2. issues `TUSDC`, opens trustlines, pays the payer 100 TUSDC and deploys the asset's Stellar Asset Contract;
3. starts the facilitator, the reference seller and the discovery index on ephemeral localhost ports;
4. registers the seller with the index, which fetches the manifest and a live 402 from each route before listing it;
5. `GET /weather` returns 402; the payer signs a Soroban authorization entry; the seller verifies and settles through the facilitator and answers 200 with a `PAYMENT-RESPONSE` header;
6. replays the same payload and shows it refused (`invalid_exact_stellar_payload_nonce_reused`);
7. prints the transaction hash and a `stellar.expert` testnet link.

To pay with Circle's testnet USDC instead of TUSDC: fund the payer address printed by the demo at https://faucet.circle.com (network: Stellar testnet), then set `DEMO_ASSET_CONTRACT=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` and run again. The USDC contract and issuer (`GBBD47IF…FLA5`, home domain centre.io) were verified on Horizon testnet on 2026-10-23. The faucet is a manual form, which is why the automated demo issues its own asset.

## Run the services on their own

```bash
cp .env.example .env         # fill FACILITATOR_SECRET with a funded testnet S... key
npm run build
npm --workspace @genesis402/stellar-facilitator start      # :4021  /supported /verify /settle
npm --workspace @genesis402/stellar-discovery start        # :4022  /discovery/resources
SELLER_ADDRESS=G... npm --workspace @genesis402/example-reference-seller start   # :4023
```

## Protocol surface

Wire format is x402 v2 and the `exact` scheme for Stellar as specified in [coinbase/x402 `specs/schemes/exact/scheme_exact_stellar.md`](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md): networks `stellar:testnet` / `stellar:pubnet`; `payload.transaction` is the base64 XDR of a one-operation `invokeHostFunction` transaction calling `transfer` with the buyer's signed authorization entry; `extra.areFeesSponsored: true`.

| Endpoint | Body / result |
|---|---|
| `GET /supported` | `{ kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } }], extensions: [], signers: { "stellar:*": [facilitator] } }` |
| `POST /verify` | `{ x402Version, paymentPayload, paymentRequirements }` → `{ isValid, invalidReason?, payer? }` |
| `POST /settle` | same body, optional `Idempotency-Key` (the seller's claim) → `{ success, transaction, network, payer, amount?, errorReason? }`; 429 when the fee-drain guard refuses; 401 in bearer mode without a token |
| Seller `GET /.well-known/x402` | x402 v2 manifest: `provider`, `services[]` with `endpoint`, `method`, `price_usd`, `accepts[]`, `input_schema`, `output_schema` |
| Index `GET /discovery/resources?network=stellar:testnet&max_amount=&category=&q=` | listed resources; `GET /discovery/schema` gives the JSON Schema |
| Index `POST /discovery/sellers {manifest_url}` | `202 { job_id }`; poll `GET /discovery/jobs/:id`. Rate-limited per client (socket address, or `X-Forwarded-For` only with `TRUST_PROXY=1`); bounded queue (`503 queue_full`) |
| Seller route, ambiguous settlement | `409 { error: "settlement_pending", accepts, transaction? }` — re-send the same `PAYMENT-SIGNATURE` |

Settlement rules added in review round r1:

- **Asset allowlist.** The facilitator sponsors only token contracts in `ALLOWED_ASSETS` (default: Circle USDC on the network). Anything else is refused at `/verify` with `invalid_exact_stellar_payload_asset_not_allowed`. The demo adds its `TUSDC` contract explicitly; a public instance must not.
- **One settlement at a time per signer.** A Stellar account has one sequence number, so settles are serialized with an in-process mutex; throughput is one settlement per ledger per signer. Channel accounts are the T2 answer. `TRY_AGAIN_LATER` and `ERROR` from `sendTransaction` release the buyer's nonce (the envelope was not admitted); a thrown send keeps it (ambiguous).
- **Never charge twice.** If the facilitator's answer after submission is ambiguous (HTTP 5xx, `not_confirmed`, `unexpected_settle_error`), the seller SDK checks Horizon for the transaction hash and delivers when it is included; otherwise it answers HTTP 409 `settlement_pending` with the same terms and the buyer re-sends the **same** `PAYMENT-SIGNATURE`. A fresh 402 is never issued for a payment that may have landed.
- **Payment bound to the resource.** `payload.resource.url` must name the route being paid (origin + path); a header signed for `/weather` is refused on `/echo` with `resource_mismatch`.
- **Fixed error codes only.** No facilitator, RPC or Horizon text is ever forwarded to a buyer or to a discovery client.

Added in review round r2 and from the threat model:

- **One payment, one delivery.** Requests carrying the same `PAYMENT-SIGNATURE` are processed one at a time per seller; the seller sends an `Idempotency-Key` (its claim) on `/settle`, and only a `/settle` with that same key can read the recorded outcome back. Any other key, and every replay, gets `nonce_reused` — which the seller never turns into a delivery, whatever the chain says. Two concurrent retries of one pending payment yield one 200.
- **Pending state ends.** A `settlement_pending` record expires once the envelope time bounds and the auth-entry expiry have both passed (2 × `maxTimeoutSeconds` + 30 s); the next retry gets a terminal 402 with a fresh quote (`settlement_expired`), after one last Horizon check.
- **Method binding.** A quote for anything other than GET carries `extra.method`; a GET quote presented on POST (or the reverse) is `resource_mismatch`.
- **Bounded critical section.** Every RPC/Horizon call has a 20 s timeout and the locked part of a settlement a 12 s deadline (`settleDeadlineMs`); past it the signer is released for the next buyer and the stalled settlement is reported as ambiguous with its hash while the buyer's claim is kept.
- **Fee-drain guard.** `FEE_BUDGET_STROOPS_PER_HOUR` (default 5,000,000 = 0.5 XLM) caps the fees the facilitator sponsors per trailing hour; `FEE_BUDGET_PER_SELLER_STROOPS_PER_HOUR` caps one seller's share of it — the seller is the `payTo` address in open mode and the bearer token in bearer mode, so rotating `payTo` addresses does not widen an authenticated seller's share. Default share: `min(max(budget / 4, MAX_TRANSACTION_FEE_STROOPS), budget)` = 1,250,000; an explicit share larger than the budget refuses to start. `MAX_SETTLES_PER_SELLER_PER_HOUR` (default 600) caps settlements per seller. All three refuse before any claim with HTTP 429 (`fee_budget_exhausted`, `seller_fee_budget_exhausted`, `seller_rate_limited`) and `Retry-After`; the refused entry stays valid. Ambiguous and thrown submissions are charged at the fee ceiling, since the fee may have been spent. `/health` shows the hour's usage and the budgets, never a seller or payer.
  **Plainly, the limit of this guard:** in open mode the share is per `payTo`, and `payTo` is free to mint. Four addresses controlled by one party each take a quarter (296 dust settlements at 16,860 stroops) and the hour is gone for everyone else; with a fee ceiling above a quarter of the budget, two addresses do it. The guard bounds the *cost* of an attack (0.5 XLM per hour by default) and keeps one honest seller from starving the rest; it does not stop a determined attacker in open mode. A hosted instance must run in bearer mode (`SELLER_TOKENS`), where the share follows the token.
- **Seller authentication (optional).** `SELLER_TOKENS` set → `/verify` and `/settle` require `Authorization: Bearer <token>` (hash-then-compare, constant time); unset → open API (self-host default: keep it on the seller's network). `/supported`, `/` and `/health` advertise `sellerAuth: "open" | "bearer"`. In bearer mode a claim key is scoped to the token that presented it. Sellers pass the token as `facilitatorToken` in `createPaywall` (or `FACILITATOR_TOKEN` for the reference seller); in a URL, `https://TOKEN@host`, `https://:TOKEN@host` and `https://bearer:TOKEN@host` also mean Bearer, and only an explicit `user:password` pair is sent as Basic — so a token that itself contains `:` must be passed as `facilitatorToken` or percent-encoded in the URL, or it is parsed as a user/password pair.
- **Strict configuration.** Every numeric environment value (`MAX_TRANSACTION_FEE_STROOPS`, the three fee-guard values, `PORT`, `TRUST_PROXY_HOPS`) must be a plain non-negative integer — `"5,000,000"`, `"0.5 XLM"` or `"600/h"` refuse to start, exactly as a malformed `ALLOWED_ASSETS` does. A non-integer passed in code fails closed (budget 0), never silently off.
- **Allowlist validation.** Every `ALLOWED_ASSETS` entry must be a contract strkey; blanks are ignored; an empty list refuses to start.
- **Proxy identity.** With `TRUST_PROXY=1` the client is the `TRUST_PROXY_HOPS`-th entry from the right of `X-Forwarded-For` (default 1, must be a positive integer); a chain shorter than the hop count falls back to the rightmost entry, never to the client-supplied left one. IPv6 clients are limited per /64; IPv4 carried inside IPv6 (`::ffff:a.b.c.d` in either spelling, SIIT, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`) is unwrapped and limited as that IPv4 address.
- **Ambiguous retries.** If any `sendTransaction` attempt failed at the transport level, a later `ERROR`/`TRY_AGAIN_LATER` is not proof the envelope was never admitted: the claim is kept and the hash returned so the seller can poll; only a clean first-attempt `ERROR`/`TRY_AGAIN_LATER` releases the buyer's entry. A claim that never reached the network is released once the entry's expiry ledger has passed.
- **Durable pending state (seller).** `createPaywall({ pendingStore })` accepts any `PendingStore`; `SqlitePendingStore` is provided. The record `{digest → claim key, hash}` is written **before** `/settle`, so a seller that restarts (or a fleet sharing the store) finishes a payment whose facilitator answer was lost, by re-asking with its own claim key. The default is in-memory per instance. After expiry the record becomes a tombstone that still carries the claim key, so a late-landing transaction is served; a definitive facilitator refusal (4xx) is a 402, never a 409.
- **One delivery per payment, for the cases the tests exercise (r4, r5).** Delivery is gated by `PendingStore.consume(digest, claimKey)`, an atomic "delete the record if it still carries this claim key" that succeeds for one caller only; every later write to a record goes through `PendingStore.update`, an owner-checked conditional update that never inserts, so a consumed record cannot be re-created by a late answer. A holder whose lease was taken over (`LeaseHandle.held()` is false) neither writes nor delivers. Proven by tests: a lease zeroed mid-settle with a second instance taking over, in-process and from another process holding a 2 s write lock (reviewer r5 `lease-lapse-resurrect` ×3, 10/10 standalone runs; own `seller r5-fixes`); a `consume` lost to another holder (409, replay 402); a lock held past `lockWaitMs` (503). Not tested, so not claimed: a lease lost and retaken more than once within a single request, and any store other than the two shipped. The SQLite lease is renewed every third of its length while the request runs; the facilitator's ledger lookup, the Horizon confirmation and the facilitator HTTP call itself are bounded (12 s, 5 s, and `facilitatorTimeoutMs` 18 s, after which the call counts as a lost answer → 409); a caller that cannot get a payment's lock within `lockWaitMs` (15 s, in-memory and SQLite alike) gets HTTP 503 `settlement_busy` with `Retry-After`, as does a request that meets SQLite's `database is locked` past `busyTimeoutMs`. Live records are never evicted for space; tombstones are bounded (1,000 in memory; SQLite keeps 10,000 for 24 h, swept at most once per `sweepIntervalMs` = 60 s over an index on `(state, expires_at)`); live rows nobody has touched for `abandonedLiveMs` (default 7 days) are collected.
- **Claimants outlive the entry's ledger (r4).** The facilitator checks the nonce record before the entry's expiry, so a seller re-asking with its own claim key after the auth entry's ledger has passed still gets the recorded outcome and hash. A `claimed` row whose send never happened is released once the entry's expiry ledger passes (reachable now for the claiming payload itself); submitted rows are never released.

Verification rules (all enforced before any fee is paid): asset on the allowlist; x402Version 2; scheme `exact`; one `invokeHostFunction` op; contract equals `asset`; function `transfer` with three args; `to` equals `payTo`; amount equals `amount` exactly; facilitator is not tx source, op source, `from`, or any auth address; address-type credentials only; no sub-invocations; auth invocation equals the operation; expiry after the current ledger and no later than `current + ceil(maxTimeoutSeconds / ledgerSeconds) + 2`; Ed25519 signature verifies locally against `from`; nonce not already consumed; simulation succeeds; simulation shows exactly one transfer `from → payTo` of the exact amount on `asset`; simulation fee plus inclusion fee under the 50,000-stroop ceiling.

## Tests

```bash
npm test                 # unit tests, no network
npm run test:testnet     # adds the real testnet round trip (STELLAR_TESTNET_TESTS=1), about a minute
```

Counts: 84 unit tests at the r1 review baseline (commit 52b2e34); HEAD runs 217 passing plus the one env-gated testnet test (`npm test` prints the current number; CI runs it on every push). Negative cases required by the brief, all in `packages/facilitator/test/verify-static.test.ts`: wrong amount, wrong destination, expired, replayed nonce, wrong asset, tampered signature. Review-round fixes are covered by `packages/*/test/r1-fixes.test.ts` through `r4-fixes.test.ts`, the threat-model guards by `packages/facilitator/test/threat-model.test.ts`, discovery abuse cases by `packages/discovery/test/security.test.ts`.

## Layout

```
packages/facilitator     x402 facilitator (verify, settle, supported) + payer helpers
packages/seller-sdk      402 paywall, Hono middleware, manifest builder, x402 wire schemas
packages/discovery       crawler, SQLite index, discovery API, SSRF guard
examples/reference-seller  two paid routes behind the paywall + manifest
examples/payer           testnet demo and the opt-in integration test
docs/SCF.md              what this repo delivers against the SCF #46 tranches
ARCHITECTURE.md          flow and component diagram
SECURITY.md              threat model (STRIDE) and reporting
```

## Not in this repository

No mainnet configuration beyond the network passphrase, no bridge, no hosted instance. The settlement contract in `contracts/x402-settle` (branch `t2/rebase-main`, not yet merged to `main`) exists on testnet only and is not called by the facilitator yet. The only asset this repo issues is the valueless testnet demo asset `TUSDC`, created by `npm run demo:testnet` from a throwaway issuer so the automated demo can run without the manual Circle faucet; nothing here issues a production or value-bearing token. Mainnet is a separate milestone with its own review.
