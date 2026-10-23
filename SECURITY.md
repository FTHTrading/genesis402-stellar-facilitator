# Security

Report issues to kevan@unykorn.org. Please do not open public issues for exploitable findings; we will acknowledge within 3 business days.

Scope of this document: the code in this repository as run on Stellar **testnet**. There is no mainnet deployment and no hosted instance (**NOT DEPLOYED**). Mainnet is a separate milestone with its own review.

## Trust model

- The facilitator holds one Stellar keypair that pays transaction fees. It never holds buyer funds: a valid payload moves tokens `buyer → seller` inside the token contract, authorized by the buyer's own signature, and the facilitator is rejected as `from`, `to`, transaction source, operation source, or authorizer.
- The buyer trusts nothing but the token contract and their own signature: the authorization entry binds the exact invocation, network, nonce and expiry.
- The seller trusts the facilitator's `/verify` and `/settle` answers and should run its own facilitator or one it controls. The facilitator URL is configuration, never taken from a request.
- The discovery index treats every manifest and every seller response as attacker-controlled input.

## STRIDE table

| Threat | Where | Control | Test |
|---|---|---|---|
| **Spoofing**: payload signed by a key other than the payer | facilitator | Local Ed25519 verification over the CAP-71 / legacy preimage; `public_key` must equal `from` | `verify-static: tampered signature` |
| **Spoofing**: facilitator tricked into paying from its own account | facilitator | Facilitator address rejected as tx source, op source, `from`, and any auth address; simulation events must show the only balance change is buyer → seller | `facilitator is the payer`, `facilitator is the transaction source`, `more than one balance change` |
| **Spoofing**: manifest claims another seller's origin or endpoints | discovery | `seller_origin` is pinned to the manifest URL's origin; `provider.origin` host must equal the manifest host; endpoints on another origin are never fetched (`cross_origin_endpoint`) | `security: pins seller_origin…`, `provider.origin names a different host` |
| **Tampering**: amount, destination or asset changed after the quote | facilitator, seller SDK | Exact i128 amount, exact `payTo`, exact contract id; seller refuses payloads whose `accepted` differs from its own quote (`accepted_terms_mismatch`) | `wrong amount`, `wrong destination`, `wrong asset contract`, `paywall: refuses a payment whose accepted terms differ` |
| **Tampering**: auth entry authorizes something other than the operation | facilitator | Authorized invocation must equal the operation's `InvokeContractArgs` byte for byte; no sub-invocations; address credentials only | `verify.ts` (`auth_mismatch`, `has_subinvocations`, `unsupported_credential_type`) |
| **Tampering**: redirect from a seller to a different host during a crawl | discovery | `redirect: "manual"` on every outbound request; non-200/402 statuses are failures | `security: countingFetch asserts redirect manual` |
| **Repudiation**: dispute over whether a call was paid | facilitator, seller SDK | Settlement receipt `{success, transaction, network, payer}` returned in `PAYMENT-RESPONSE`; the transaction hash is public on Stellar | demo prints hash + explorer link |
| **Information disclosure**: internal hostnames or stack traces leaked by the index | discovery | Job and error responses carry a fixed code set only (`target_not_allowed`, `manifest_unreachable`, `manifest_invalid`, `origin_mismatch`, `body_too_large`, `crawl_failed`); the submitted URL is not echoed | `security: never echoes internals` |
| **Information disclosure**: keys in logs or repo | all | No secret is ever logged; `.env` and `demo-keys.json` are gitignored; `.env.example` has empty values | `git ls-files` contains no `.env` |
| **Denial of service**: replaying one signed payment to drain the facilitator's fee balance | facilitator | Nonce table checked at verify and claimed atomically at settle; the ledger also consumes the nonce on apply | `replayed nonce`, `refuses to settle the same signed payload twice` |
| **Denial of service**: payload that simulates to a huge fee | facilitator | `minResourceFee + inclusion <= 50,000` stroops ceiling (configurable) | `fee exceeds the ceiling` |
| **Denial of service**: long-lived signatures held and submitted later | facilitator | Expiry must be in `(current, current + ceil(timeout/ledgerSeconds) + 2]` | `expired`, `expires beyond maxTimeoutSeconds` |
| **Denial of service**: oversized or endless manifest / 402 bodies | discovery | Streaming read with a hard 256 KiB cap, `application/json` content type required, 50 services per manifest, 4 concurrent fetches per crawl, 15 s timeout per request | `aborts a manifest body larger than 256 KiB`, `without a JSON content type`, `at most 50 services` |
| **Denial of service**: registration flood | discovery | Per-IP window (default 5 per 10 min, HTTP 429), registration is queued and processed one crawl at a time, job table bounded at 1000 | `rate-limits registrations per client IP` |
| **Elevation of privilege**: SSRF through `manifest_url` or a service endpoint | discovery | `assertSafeTarget`: https only, no credentials, hostname resolved and **every** address must be public (rejects loopback, RFC 1918, 100.64/10, 169.254/16 incl. 169.254.169.254, 0/8, multicast, `::1`, `fc00::/7` incl. `fd00:ec2::254`, `fe80::/10`, `ff00::/8`, v4-mapped and 6to4/NAT64 embedded private); `.local`/`.internal`/`localhost` names rejected | 12 range cases + `resolves to a private address` + `never fetches a private-IP manifest` + `cloud metadata` |
| **Elevation of privilege**: cross-site registration from a browser | discovery | CORS is wildcard for `GET` reads only; `POST /discovery/sellers` and its preflight carry no `Access-Control-Allow-Origin` | `allows cross-origin reads but not cross-origin registration` |
| **Elevation of privilege**: malformed JSON to the facilitator API | facilitator | zod validation of every request body; 400 with issues, nothing executed | `app: rejects a malformed body with 400` |

## Known limits (T1)

- The facilitator's fee account is a single hot key on testnet. Mainnet needs a funded fee account with a balance alert, a fee-bump signer separated from the sequence account, and a key-rotation runbook; none of that exists yet.
- The nonce store is SQLite on one host. Two facilitator instances sharing one signer would need a shared store or distinct signers.
- The discovery index trusts DNS at crawl time; a host that resolves publicly at check time and privately a moment later (DNS rebinding) is only mitigated by using the resolved address check immediately before each fetch. Pinning the connection to the checked address requires a custom agent and is a follow-up.
- `allowLocalTargets` exists so the demo can crawl `127.0.0.1`. A public index must never enable it.
- Rate limiting is per process and keyed on `X-Forwarded-For`; behind a proxy that header must be set by the proxy and stripped from clients.
- Ambiguous settlement: if `sendTransaction` is accepted but the confirmation poll fails (the public SDF testnet RPC returned Cloudflare 5xx during the T1 demo runs), the facilitator answers `unexpected_settle_error` or `settle_exact_stellar_transaction_not_confirmed` with the transaction hash while the payment may already be on chain. The nonce stays consumed (correct), but the seller SDK then returns 402 to a buyer who has paid. Observed once on 2026-10-23. Mitigations in T1: retries with backoff on every RPC read and on `sendTransaction` (idempotent by hash), Horizon fallback for sequence numbers. Still needed: the seller SDK should treat a failure that carries a hash as "pending" and re-check the hash before refusing delivery.
- The public SDF testnet RPC (`soroban-testnet.stellar.org`) is shared infrastructure and was intermittently unavailable during T1. Run against a dedicated RPC provider for anything beyond a demo.
- No authentication on the facilitator API. Anyone who can reach it can ask it to settle valid payments (and so spend its fee balance on valid, buyer-authorized transfers). Put it behind the seller's network or add a bearer token before exposing it.

## Out of scope

Compromise of the buyer's signing key, of the token contract, or of the Stellar network itself.
