# Stellar Community Fund #46 — deliverable map

Project: Genesis402 Stellar Facilitator (open-source x402 facilitator on Stellar with Bazaar-style discovery). Applicant: UnyKorn LLC (Wyoming). Submission deadline 2026-11-08.

Labels: **REAL** = runs on Stellar testnet from this repo; **TESTED** = unit tests, no network; **DEMO** = stand-in for the demo only; **NOT DEPLOYED** = no public instance; **ABSENT** = not built.

## T1 — testnet MVP (this repository, built before the deadline, unfunded)

| Brief item | Delivered | State |
|---|---|---|
| Facilitator service `GET /supported`, `POST /verify`, `POST /settle` for scheme `exact` on `stellar:testnet` | `packages/facilitator` | API **TESTED**; settlement **REAL** on testnet via the demo; **NOT DEPLOYED** publicly |
| Payload = x402 v2 PaymentPayload carrying a signed Soroban authorization entry for one SEP-41 `transfer` | `packages/facilitator/src/client.ts`, `verify.ts` | **REAL** (the demo's settled transaction uses the auth-entry path; no classic-payment fallback was needed) |
| Verify amount, asset, destination, expiry, nonce not reused (SQLite), simulate via Soroban RPC | `verify.ts`, `nonce-store.ts`, `facilitator.ts` | **TESTED** + **REAL** |
| Settle: submit, wait for inclusion, return `{success, transaction, network, payer}` | `facilitator.ts`, `chain.ts` | **REAL** |
| Fee sponsorship by the facilitator for the fee only; never holds buyer funds | rebuild with facilitator as source; facilitator rejected as from/to/auth | **REAL**, **TESTED** |
| Seller SDK: `paywall(...)` returning 402 with x402 v2 `accepts` for Stellar USDC, calling the facilitator | `packages/seller-sdk` | **TESTED** |
| `GET /.well-known/x402` manifest with Bazaar-compatible fields | `packages/seller-sdk/src/manifest.ts` | **TESTED** |
| Discovery index + JSON schema; crawl manifests; list only after a real 402; `GET /discovery/resources?network=` | `packages/discovery` | **TESTED**; **NOT DEPLOYED** |
| Reference seller and payer proving an end-to-end paid call on testnet | `examples/` | **REAL** (see the demo transcript in the T1 report) |
| Testnet USDC | Circle testnet USDC contract `CBIELTK6…DAMA` supported and verified on Horizon; the automated demo issues `TUSDC` because Circle's faucet is a manual form | Circle USDC path: configured, **not exercised by the automated demo**; `TUSDC`: **DEMO** |
| Tests: ≥25 vitest tests incl. six negative cases; testnet integration behind an env flag; crawler test with a mock seller; CI | 80 unit tests, 1 opt-in integration test, `.github/workflows/ci.yml` | **TESTED**; CI state is in the T1 report |
| Docs: README, ARCHITECTURE.md (Mermaid), SECURITY.md (STRIDE), this file | repo root, `docs/` | written |

Out of T1 scope and **ABSENT** here: Soroban settlement contract, mainnet, token issuance, any bridge, marketing copy.

## After award — tranches (from the application; nothing below exists yet)

| Tranche | Share | Deliverable | State today |
|---|---|---|---|
| T1 MVP | 20% | the contents of this repository, plus a public testnet facilitator URL | code **REAL/TESTED**; public URL **NOT DEPLOYED** |
| T2 Testnet | 30% | Soroban settlement contract (escrow-settle, replay protection, fee split) with unit and integration coverage; discovery UI; 50 Genesis402 endpoints on the Stellar lane on testnet; 100 calls/min load test; public testnet demo | **ABSENT** |
| T3 Mainnet | remaining | mainnet deployment with documented rollback, threat model and monitoring plan, alerting on settlement failures, Genesis402's own endpoints switched to the Stellar lane | **ABSENT**; requires a separate review and sign-off |

## Success measure offered to the panel

Count of settled x402 payments on Stellar through this facilitator (transaction hashes are public), and count of distinct resources listed in the discovery index after a verified 402. Both are reproducible from chain data and from `GET /discovery/resources`.

## Honesty notes

- The demo asset `TUSDC` has no value and is re-issued per run. Replace it with Circle testnet USDC by funding the payer at faucet.circle.com; the code path is identical.
- "Bazaar-style" means the manifest and index use the same field pattern as the Coinbase x402 Bazaar (resource, price, lane, schema). This index is not operated by Coinbase and is not listed there.
- Hosted Stellar x402 facilitators exist (OpenZeppelin Relayer plugin, Vellar). This project's distinct parts are the self-hostable facilitator with a tested verifier, the chain-aware discovery index with a live-402 listing rule, and the seller catalogue that gives it day-one content.
