# T2: moving `/settle` from a direct token transfer to the `x402-settle` contract

State: the contract is **TESTED on testnet** (`CAGID4DCA5IY7REZYHJWSTHU3BPE5VABPTRW3ASMNW3U7JK2XTTLE2MQ`, see `contracts/x402-settle/DEPLOY-TESTNET.md`), **NOT DEPLOYED to mainnet**, and **not yet wired** to `packages/facilitator`. This note is the design for the wiring; it changes no code under `packages/`.

## What changes in the payload

| | T1 (today) | T2 (contract path) |
|---|---|---|
| Transaction the buyer's payload carries | one `invokeHostFunction` calling `transfer(from=payer, to=seller, amount)` on the **token** contract | one `invokeHostFunction` calling `settle(payer, seller, token, amount, nonce, expiry_ledger)` on the **x402-settle** contract |
| What the payer's authorization entry authorizes | the token `transfer` invocation (root), no sub-invocations | the `settle` invocation (root) **with** its one sub-invocation `token.transfer(payer, seller, amount)`. Simulation produces this tree; the payer signs over all of it (CAP-71 V2 credentials, as the T2 integration test does) |
| Replay protection | facilitator-local SQLite `consumed_nonces` plus the ledger's one-time auth nonce | the same two, **plus** the contract's persistent `(payer, nonce)` entry, which every facilitator process and every seller can read |
| Fee to the facilitator | none; the facilitator pays the network fee | none; the contract has no fee logic. A per-settlement platform fee is transaction-based compensation, which UnyKorn's standing rule forbids; facilitator revenue, if any, is a flat subscription outside the chain |

The `nonce` argument is the quote nonce from the 402 (`accepts[].extra.nonce`, 32 bytes, hex). It is unrelated to the Soroban auth nonce the SDK picks when signing the entry.

## Verification order (what `verify.ts` would check instead)

Steps 1, 2, 5, 6, 7 of the T1 order in `ARCHITECTURE.md` stay. Step 3 (invocation) becomes:

- contract id equals the configured `X402_SETTLE_CONTRACT` for the network (one allowlisted settlement contract per network; `requirements.asset` is still the token);
- function is `settle` with exactly 6 arguments;
- `payer` is not a facilitator address; `seller == requirements.payTo`; `token == requirements.asset`; `amount == requirements.amount` as i128;
- `nonce` equals `requirements.extra.nonce`; `expiry_ledger` is within the same window as the auth entry's `signatureExpirationLedger`.

Step 4 (authorization entries) changes in one place: the payer's entry is allowed, and required, to carry exactly one sub-invocation, the token `transfer(payer, payTo, amount)` the contract will perform, byte for byte, with no others. Step 9 (events) then expects one `settled` event from the contract plus one `transfer` event from the token, and nothing else.

The asset allowlist (r1 I-2) still applies to `token`. The settlement contract is a second allowlist entry, by network.

## What the on-chain nonce buys

1. **Cross-process replay protection.** In T1 the "nonce not reused" rule lives in one SQLite file. Two facilitator processes, or a restored backup, or a seller that switches facilitators, can each be shown the same signed payload once. With the contract, the second `settle` fails inside the ledger with `Error(Contract, #1) AlreadySettled`, whichever process submits it. The SQLite table stays as a cheap pre-check; it is no longer the safety boundary.
2. **Recovery by reading state.** The T1 review left two limits open: "pending state is per seller process" and "replay refusal is final". With the contract, a seller (or the facilitator) that lost its memory of a settlement asks the chain: `is_settled(payer, nonce)`. `true` means the buyer paid for this quote; deliver the resource (the `settled` event carries seller, token, amount and ledger if a receipt is needed). `false` means nothing landed; the quote may be re-settled or re-quoted. The facilitator's own `nonce_reused` answer can be checked the same way, so a refusal is no longer the end of the conversation.
3. **Receipts that do not depend on us.** The `settled{payer, seller, token, amount, nonce, ledger}` event is public ledger data keyed by the quote nonce; any party can prove a payment without the facilitator's database.

What it does not buy: the contract does not escrow, does not hold funds (the transfer goes payer to seller inside one invocation, authorized by the payer), takes nothing for anyone, and does not reduce the network fee the facilitator sponsors; a `settle` costs a little more than a bare `transfer` (one extra persistent entry write).

## Immutability

`x402-settle` v1 has no admin, no upgrade function and no pause. The address is final. A v2 is a new contract at a new address; sellers adopt it by quoting it in `accepts[]`, facilitators by adding it to their per-network allowlist. Nothing can change the code behind a quote after the buyer signed.

## The official package

The official x402 Stellar scheme implementation is `@x402/stellar` (npm; 2.28.0 on 2026-10-23, Apache-2.0, repository `x402-foundation/x402`). It pins `@stellar/stellar-sdk ^16.3.0`; this repository uses `^17`. Adopting its wire types and helpers (payload shape, `ExactStellarScheme` naming, fee-sponsorship flags) so that payloads produced by its client verify here unchanged is a T2 follow-up, after the SDK major-version difference is checked against `authorizeEntry` and the CAP-71 credential type. Observed while building the T2 test on sdk 17: `simulateTransaction` can return the payer's entry already as `sorobanCredentialsAddressV2`, so a signer must accept both credential forms.

## Work list for the wiring (not done in this milestone)

1. `verify.ts`: accept the `settle` shape above behind a per-network `settlementContract` setting; keep the direct-transfer shape for backwards compatibility until sellers have moved.
2. `client.ts`: `buildSettlePayload(...)` that simulates, signs the payer's entry including sub-invocations, and emits the x402 v2 payload.
3. Seller SDK: quote `extra.nonce`; on `nonce_reused` or a lost pending record, read `is_settled` and deliver when `true`.
4. Tests first for each: the six negative cases plus `extra sub-invocation`, `sub-invocation amount != amount`, `wrong settlement contract`.
