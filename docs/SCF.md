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
| Tests: ≥25 vitest tests incl. six negative cases; testnet integration behind an env flag; crawler test with a mock seller; CI | 84 unit tests at the r1 review baseline (52b2e34), 203 at HEAD, plus 1 opt-in integration test, `.github/workflows/ci.yml` | **TESTED**; CI state is in the T1 report |
| Review round r4 (2026-10-23): 1 Critical (SQLite lease takeover → double delivery), 1 Important, 7 Minor | all fixed test-first: atomic `consume` delivery gate, renewed leases, bounded facilitator check and Horizon confirm, 503 busy; nonce record read before entry expiry; stale-claim release reachable; share keyed by token in bearer mode and rejected above the budget; ambiguous sends charged; live records never evicted, tombstone sweep; IPv4-in-IPv6 unwrapped | **TESTED** |
| Review round r3 (2026-10-23): 0 Critical, 4 Important, 7 Minor; ruling on durable seller state | all fixed test-first (ambiguous retried sends keep the claim, bearer in the SDK, strict numeric config, per-seller fee share, 4xx → 402, tombstones, strict hop count, IPv6 /64, token-scoped claim keys, hash-then-compare, stale-claim release; `pendingStore` option with a SQLite adapter) | **TESTED** |
| Review round r1 (failure-path reviewer, 2026-10-23): 6 Important + 10 Minor findings | all fixed test-first; the reviewer retired the one r1 test that contradicted the replay rule | **TESTED** |
| Review round r2 (2026-10-23): 1 Critical (paywall bypass introduced by r1), 3 Important, 5 Minor; threat-model DoS.6 and Elevation.4 | all fixed test-first (claimant-keyed settlement, bounded critical section, rightmost-hop proxy identity, pending expiry, method binding, fee-drain guard, optional seller bearer auth); one reviewer test asserts delivery after a seller restart, which the reviewer's own text and M-r2-1 call a documented limit (see T1 report, "Fixes r2") | **TESTED** |
| Docs: README, ARCHITECTURE.md (Mermaid), SECURITY.md (STRIDE), this file | repo root, `docs/` | written |

Out of T1 scope and **ABSENT** in T1: Soroban settlement contract, mainnet, token issuance, any bridge, marketing copy.

## T2 — settlement contract (branch `t2/settlement-contract`, testnet only, $0)

| Item | Delivered | State |
|---|---|---|
| Soroban contract `x402-settle`: `settle(payer, seller, token, amount, fee, nonce, expiry_ledger, facilitator)`, `is_settled`, `version`; payer `require_auth`, persistent `(payer, nonce)` guard with TTL extension, expiry check, flat fee split only when `fee > 0`, `settled` event, no admin or upgrade key | `contracts/x402-settle` | **TESTED on testnet**: `CA5LF4WBEXMFGX4BQCSLVEXVV6U3AUIQ55KNTSIQVD3HDEXAEEWFE5BC` (`contracts/x402-settle/DEPLOY-TESTNET.md`); **NOT DEPLOYED to mainnet** |
| 20 Rust unit tests (success, replay, expired, wrong auth, zero and negative amount, insufficient balance, fee arithmetic, event) | `contracts/x402-settle/src/test.rs`, `cargo test` | **TESTED** |
| Node integration test on testnet (`T2_TESTNET=1`): deploy, fund with the DEMO asset, settle once with a fee, read `is_settled`, replay refused on chain | `contracts/x402-settle/test/testnet.integration.test.ts` | **TESTED on testnet** (transcript in the T2 report) |
| Facilitator switch from direct token transfer to the contract | `docs/T2-contract-path.md` | design only; **not yet wired** |

## After award — tranches (from the application; nothing below exists yet)

| Tranche | Share | Deliverable | State today |
|---|---|---|---|
| T1 MVP | 20% | the contents of this repository, plus a public testnet facilitator URL | code **REAL/TESTED**; public URL **NOT DEPLOYED** |
| T2 Testnet | 30% | Soroban settlement contract (escrow-settle, replay protection, fee split) with unit and integration coverage; discovery UI; 50 Genesis402 endpoints on the Stellar lane on testnet; 100 calls/min load test; public testnet demo | **ABSENT** |
| T3 Mainnet | remaining | mainnet deployment with documented rollback, threat model and monitoring plan, alerting on settlement failures, Genesis402's own endpoints switched to the Stellar lane | **ABSENT**; requires a separate review and sign-off |

## Success measure offered to the panel

Count of settled x402 payments on Stellar through this facilitator (transaction hashes are public), and count of distinct resources listed in the discovery index after a verified 402. Both are reproducible from chain data and from `GET /discovery/resources`.

## Honesty notes

- The demo issues an asset: `TUSDC`, from a throwaway testnet issuer, per run. It has no value and exists only because Circle's testnet faucet is a manual form. No other token is issued anywhere in this project. Replace it with Circle testnet USDC by funding the payer at faucet.circle.com; the code path is identical.
- "Bazaar-style" means the manifest and index use the same field pattern as the Coinbase x402 Bazaar (resource, price, lane, schema). This index is not operated by Coinbase and is not listed there.
- Stellar x402 facilitators already exist and this project is not the first or the only one. Known as of 2026-10-23: the Coinbase-run facilitator at [x402.org/facilitator](https://x402.org/facilitator/supported) advertises `stellar:testnet` with sponsored fees (its `/supported` was read on that date); [Openx402 by Ithaca-Labs](https://github.com/Ithaca-Labs/openx402) (Apache-2.0, `stellar:testnet` preview, Bazaar-style discovery and a proposed `upto` scheme); the OpenZeppelin Relayer plugin; and Vellar. The official Stellar scheme package is [`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar) (2.28.0 on 2026-10-23, Apache-2.0, repo `x402-foundation/x402`). What this repository adds is one self-hostable implementation whose verifier, settlement contract and discovery listing rule are each covered by tests you can run, plus the seller catalogue that gives the index day-one content.
