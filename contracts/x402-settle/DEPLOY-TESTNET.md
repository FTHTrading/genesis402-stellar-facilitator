# x402-settle — testnet deployment record

State: **TESTED on testnet**. **NOT DEPLOYED to mainnet.** **Not yet wired to the facilitator.** v1 has **no fee logic by design** (see README: a per-settlement fee would be transaction-based compensation, which UnyKorn LLC's standing rule forbids) and **no admin or upgrade key** (a v2 is a new address).

Current instance, deployed 2026-10-23 (review round r1 fixes) by the builder session from branch `t2/rebase-main` with `stellar` 28.1.0 and a deployer key generated at runtime (`stellar keys generate t2-deployer-r1 --network testnet --fund`; stored outside the repo in the CLI's identity folder, never committed). Testnet only, no value, $0.

| Item | Value |
|---|---|
| Network | `stellar:testnet` (`Test SDF Network ; September 2015`) |
| Contract id | `CDWAJIUNSSVZFLN5FIJ3IHFHABILGEVGNYPYQMQLHFLET7JVJPXLPTHD` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CDWAJIUNSSVZFLN5FIJ3IHFHABILGEVGNYPYQMQLHFLET7JVJPXLPTHD |
| Stellar Lab | https://lab.stellar.org/r/testnet/contract/CDWAJIUNSSVZFLN5FIJ3IHFHABILGEVGNYPYQMQLHFLET7JVJPXLPTHD |
| Source commit (pinned) | `8527a50cb9d9bbc95a831ec4fbe2ca6a918c6a04` on `t2/rebase-main` (the commit that contains `src/lib.rs` as deployed; this file is committed one commit later) |
| Wasm hash (sha256 of `x402_settle.wasm`, 4,831 bytes) | `030a194106c7f1a53711bf3618f4264ef425bd70c3ee46e1a5cef7bfc2c6cf4c` |
| Wasm upload tx | https://stellar.expert/explorer/testnet/tx/7086e2b67585a670140268f53aa6fdb100a806f11f871db6a82b19797e228048 |
| Create-contract (deploy) tx | https://stellar.expert/explorer/testnet/tx/3640de1221895f4f331b657d191f7a371c1402364d6fe1642b5d7ed01fc95a72 |
| Deployer account | `GBGQIGBQQC7YHDSXL2PGO56DJCKEOHOBQOD2JL5MUB63ORGU7CYHGF2P` (friendbot-funded testnet key, no other use) |
| Toolchain | rustc 1.93.0, soroban-sdk 29.0.1, stellar-cli 28.1.0, target `wasm32v1-none` |
| Node integration run against this instance | settle tx https://stellar.expert/explorer/testnet/tx/4d6b3e285b4e88681e4a70bdfed76dc1a29e2805fbf118d2c6f45ab11c15f65f (record read back: seller, token, amount matched the quote; re-signed replay refused in simulation with `Error(Contract, #1)`) |

Reproduce the hash: check out `8527a50cb9d9bbc95a831ec4fbe2ca6a918c6a04`, run `stellar contract build` in `contracts/x402-settle`, then `sha256sum target/wasm32v1-none/release/x402_settle.wasm` (or `$CARGO_TARGET_DIR/wasm32v1-none/release/x402_settle.wasm`). The contract meta below also records the exact Rust, SDK and CLI versions.

## Verification against the live network (pasted verbatim)

```
$ stellar contract info interface --id CDWAJIUNSSVZFLN5FIJ3IHFHABILGEVGNYPYQMQLHFLET7JVJPXLPTHD --network testnet
ℹ️  Network: Test SDF Network ; September 2015
🌎 Downloading contract spec: CDWAJIUNSSVZFLN5FIJ3IHFHABILGEVGNYPYQMQLHFLET7JVJPXLPTHD
#[soroban_sdk::contractargs(name = "Args")]
#[soroban_sdk::contractclient(name = "Client")]
pub trait Contract {
    fn settle(
        env: soroban_sdk::Env,
        payer: soroban_sdk::Address,
        seller: soroban_sdk::Address,
        token: soroban_sdk::Address,
        amount: i128,
        nonce: soroban_sdk::BytesN<32>,
        expiry_ledger: u32,
    ) -> Result<(), Error>;
    fn version(env: soroban_sdk::Env) -> u32;
    fn is_settled(
        env: soroban_sdk::Env,
        payer: soroban_sdk::Address,
        nonce: soroban_sdk::BytesN<32>,
    ) -> bool;
    fn settlement(
        env: soroban_sdk::Env,
        payer: soroban_sdk::Address,
        nonce: soroban_sdk::BytesN<32>,
    ) -> Option<Settlement>;
}
#[soroban_sdk::contracttype(export = false)]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct Settlement {
    pub amount: i128,
    pub ledger: u32,
    pub seller: soroban_sdk::Address,
    pub token: soroban_sdk::Address,
}
#[soroban_sdk::contracterror]
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub enum Error {
    AlreadySettled = 1,
    Expired = 2,
    InvalidAmount = 3,
    ExpiryTooFar = 4,
    InvalidParty = 5,
}
#[soroban_sdk::contractevent(topics = ["settled"])]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct Settled {
    #[topic]
    pub payer: soroban_sdk::Address,
    #[topic]
    pub seller: soroban_sdk::Address,
    pub token: soroban_sdk::Address,
    pub amount: i128,
    pub nonce: soroban_sdk::BytesN<32>,
    pub ledger: u32,
}

$ stellar contract info meta --id CDWAJIUNSSVZFLN5FIJ3IHFHABILGEVGNYPYQMQLHFLET7JVJPXLPTHD --network testnet
ℹ️  Network: Test SDF Network ; September 2015
🌎 Downloading contract spec: CDWAJIUNSSVZFLN5FIJ3IHFHABILGEVGNYPYQMQLHFLET7JVJPXLPTHD
Contract meta:
 • rsver: 1.93.0 (Rust version)
 • rssdkver: 29.0.1#e1671a0cb58d4b8c0bb8de115caf080ca01676e8 (Soroban SDK version and its commit hash)
 • rssdk_spec_shaking: 2
 • cliver: 28.1.0#c0f4d0da891bbf214c08b8c5035ae6db80e9a3bd

$ stellar contract invoke --id CDWAJIUNSSVZFLN5FIJ3IHFHABILGEVGNYPYQMQLHFLET7JVJPXLPTHD --source t2-deployer-r1 --network testnet -- version
ℹ️  Simulation identified as read-only. Send by rerunning with `--send=yes`.
1

$ stellar contract fetch --id CDWAJIUNSSVZFLN5FIJ3IHFHABILGEVGNYPYQMQLHFLET7JVJPXLPTHD --network testnet --out-file fetched.wasm && sha256sum fetched.wasm
030a194106c7f1a53711bf3618f4264ef425bd70c3ee46e1a5cef7bfc2c6cf4c *fetched.wasm
```

The fetched wasm hashes to the same value as the local build at the pinned commit, so the code at this address is the code in this directory at `8527a50`. (The `Settlement` field order shown by the CLI is the spec's alphabetical order; the Rust source declares `seller, token, amount, ledger`.)

## Superseded testnet deployments (not to be used)

| Contract | Wasm | Why superseded |
|---|---|---|
| `CAGID4DCA5IY7REZYHJWSTHU3BPE5VABPTRW3ASMNW3U7JK2XTTLE2MQ` (deploy tx `4f176960c17d7adafe7dd508549efde48a755ac9a11edc66839aafa93c4a3871`, source commit `352267f` on `t2/rebase-main`) | `d78b356e79de52671439ada09bd714e042df3eed6511657de001859763bb12f1` | Review r1, I-1: stored only `true` under `(payer, nonce)`, so `is_settled` could not tell a seller whether it was paid. Replaced by the `Settlement` record instance above. |
| `CA5LF4WBEXMFGX4BQCSLVEXVV6U3AUIQ55KNTSIQVD3HDEXAEEWFE5BC` (deploy tx `049b77216553aad3d178fc430cc5b82c22078ea78c38dc1cb64f5160b1a5534c`) | `ce19281423356429fa221187720bba45df945f1b1ea1615eb9fff07b5ec37b6e` | First build, carried an optional flat facilitator fee split; withdrawn by Operator decision the same afternoon (transaction-based compensation is forbidden). |

Both stay on testnet because contracts cannot be removed; nothing should reference them as live. The Node integration test deploys its own fresh instance on every run unless `X402_SETTLE_CONTRACT_ID` is set; those instances are throwaway.

## What this record is not

Not a mainnet deployment, not a receipt that any facilitator calls this contract, and not an audit. Mainnet is a separate milestone with Kevan's explicit go.