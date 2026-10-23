# x402-settle

Soroban settlement contract for x402 `exact` payments on Stellar.

State: **TESTED on testnet** (`CDWAJIUNSSVZFLN5FIJ3IHFHABILGEVGNYPYQMQLHFLET7JVJPXLPTHD`, see `DEPLOY-TESTNET.md`). **NOT DEPLOYED to mainnet.** **Not yet wired** to the facilitator in `packages/facilitator`; the switch is designed in `../../docs/T2-contract-path.md`.

## Interface

```rust
fn settle(payer: Address, seller: Address, token: Address, amount: i128,
          nonce: BytesN<32>, expiry_ledger: u32) -> Result<(), Error>;
fn settlement(payer: Address, nonce: BytesN<32>) -> Option<Settlement>; // { seller, token, amount, ledger }
fn is_settled(payer: Address, nonce: BytesN<32>) -> bool;              // nonce consumed, nothing more
fn version() -> u32; // 1
```

`settle`:

1. `payer.require_auth()` — the payer authorizes exactly this invocation (contract, function, every argument) and, through the auth tree, the one token transfer it causes. Nobody else can trigger it; the facilitator only pays the network transaction fee as the envelope's source.
2. Refuses `amount <= 0` (`InvalidAmount`), `seller == payer` (`InvalidParty`), `expiry_ledger < current` (`Expired`), `expiry_ledger` more than 1,000,000 ledgers ahead (`ExpiryTooFar`).
3. Refuses `(payer, nonce)` already present (`AlreadySettled`). Otherwise writes `Settlement { seller, token, amount, ledger }` under that key in persistent storage and asks for a TTL of the quote window plus about 7 days so the record stays readable for recovery. The host clamps the TTL at the network's `max_entry_ttl - 1` (live testnet value UNVERIFIED here), so a long window can see the record archived before the quote expires; an archived key still refuses replay (it cannot be touched until restored, and once restored it reads `AlreadySettled`; after expiry `Expired` fires first).
4. `token.transfer(payer, seller, amount)`: exactly the quoted amount, all of it to the seller.
5. Emits `settled` with topics `("settled", payer, seller)` and data `{token, amount, nonce, ledger}`.

A failed transfer (for example insufficient balance) rolls the whole invocation back, so the nonce is not consumed.

## Reading a settlement

`settlement(payer, nonce)` returns what was actually settled. A seller delivers only when the record's `seller`, `token` and `amount` equal its own quote. `is_settled(payer, nonce)` says only that the nonce is consumed: the payer may have settled 1 stroop to an address it controls, or an amount on a token that moves nothing, under the seller's nonce (review r1, I-1). That consumes the nonce and blocks the honest settle with `AlreadySettled`, but it cannot make the record match the quote, so a seller that matches the record is not fooled and simply re-quotes with a fresh nonce.

## No fee logic, by design

The contract has no fee parameter, no fee recipient and no split. A per-settlement platform fee would be transaction-based compensation, which UnyKorn LLC's standing rule forbids; if the facilitator is paid at all it is a flat subscription outside the chain. The facilitator's only on-chain role is paying the network fee of the envelope it submits.

## Admin-less, by design

There is no admin address, no upgrade function, no pause switch and no fee setter. The code behind this address cannot change after a buyer has signed a quote against it. A future version is a new contract at a new address: sellers adopt it by quoting it, facilitators by allowlisting it. `version()` returns `1`.

## Build and test

```
rustup target add wasm32v1-none
cargo test                     # 18 unit tests, no network
stellar contract build         # target/wasm32v1-none/release/x402_settle.wasm
```

Testnet integration (deploys a fresh instance, pays with the DEMO asset TUSDC issued per run, settles once, reads `settlement` and `is_settled`, and shows a re-signed replay refused in simulation against live ledger state with `Error(Contract, #1)`):

```
T2_TESTNET=1 npx vitest run --config contracts/x402-settle/vitest.config.ts
```

Set `X402_SETTLE_CONTRACT_ID` to reuse an instance instead of deploying, `X402_SETTLE_WASM` to point at a wasm file. Keys are generated per run into the gitignored `test/deploy-keys.json`.

## Not here

No mainnet deployment, no escrow, no fee logic, no holding of funds (the single transfer runs payer to seller inside one payer-authorized invocation), no admin, no token issuance.
