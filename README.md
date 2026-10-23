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
| Soroban settlement contract `x402-settle` (payer-authorized `settle`, on-chain nonce, flat fee split, admin-less) | `contracts/x402-settle` | **TESTED on testnet** at `CA5LF4WBEXMFGX4BQCSLVEXVV6U3AUIQ55KNTSIQVD3HDEXAEEWFE5BC` (see `contracts/x402-settle/DEPLOY-TESTNET.md`); **NOT DEPLOYED to mainnet**; **not yet wired to the facilitator** (`/settle` still transfers through the token contract directly; the switch is designed in `docs/T2-contract-path.md`) |

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
- **Fee-drain guard.** `FEE_BUDGET_STROOPS_PER_HOUR` (default 5,000,000 = 0.5 XLM) caps the fees the facilitator sponsors per trailing hour, and `MAX_SETTLES_PER_SELLER_PER_HOUR` (default 600) caps settlements per `payTo`; both refuse before any claim with HTTP 429 (`fee_budget_exhausted`, `seller_rate_limited`) and `Retry-After`. `/health` shows the hour's usage.
- **Seller authentication (optional).** `SELLER_TOKENS` set → `/verify` and `/settle` require `Authorization: Bearer <token>`; unset → open API (self-host default: keep it on the seller's network). `/supported` advertises `extra.sellerAuth: "open" | "bearer"`.
- **Allowlist validation.** Every `ALLOWED_ASSETS` entry must be a contract strkey; blanks are ignored; an empty list refuses to start.
- **Proxy identity.** With `TRUST_PROXY=1` the client is the `TRUST_PROXY_HOPS`-th entry from the right of `X-Forwarded-For` (default 1), never the client-supplied left entry.

Verification rules (all enforced before any fee is paid): asset on the allowlist; x402Version 2; scheme `exact`; one `invokeHostFunction` op; contract equals `asset`; function `transfer` with three args; `to` equals `payTo`; amount equals `amount` exactly; facilitator is not tx source, op source, `from`, or any auth address; address-type credentials only; no sub-invocations; auth invocation equals the operation; expiry after the current ledger and no later than `current + ceil(maxTimeoutSeconds / ledgerSeconds) + 2`; Ed25519 signature verifies locally against `from`; nonce not already consumed; simulation succeeds; simulation shows exactly one transfer `from → payTo` of the exact amount on `asset`; simulation fee plus inclusion fee under the 50,000-stroop ceiling.

## Tests

```bash
npm test                 # unit tests, no network
npm run test:testnet     # adds the real testnet round trip (STELLAR_TESTNET_TESTS=1), about a minute
```

Counts: 84 unit tests at the r1 review baseline (commit 52b2e34); HEAD runs 151 passing plus the one env-gated testnet test (`npm test` prints the current number; CI runs it on every push). Negative cases required by the brief, all in `packages/facilitator/test/verify-static.test.ts`: wrong amount, wrong destination, expired, replayed nonce, wrong asset, tampered signature. Review-round fixes are covered by `packages/*/test/r1-fixes.test.ts` and `r2-fixes.test.ts`, the threat-model guards by `packages/facilitator/test/threat-model.test.ts`, discovery abuse cases by `packages/discovery/test/security.test.ts`.

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

No mainnet configuration beyond the network passphrase, no bridge, no hosted instance. The settlement contract in `contracts/x402-settle` exists on testnet only and is not called by the facilitator yet. The only asset this repo issues is the valueless testnet demo asset `TUSDC`, created by `npm run demo:testnet` from a throwaway issuer so the automated demo can run without the manual Circle faucet; nothing here issues a production or value-bearing token. Mainnet is a separate milestone with its own review.
