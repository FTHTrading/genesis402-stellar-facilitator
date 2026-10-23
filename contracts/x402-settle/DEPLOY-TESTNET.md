# x402-settle — testnet deployment record

State: **TESTED on testnet**. **NOT DEPLOYED to mainnet.** **Not yet wired to the facilitator.** v1 has **no fee logic by design** (see README: a per-settlement fee would be transaction-based compensation, which UnyKorn LLC's standing rule forbids) and **no admin or upgrade key** (a v2 is a new address).

Deployed 2026-10-23 by the builder session from this branch (`t2/settlement-contract`) with `stellar` 28.1.0 and a deployer key generated at runtime (`stellar keys generate t2-deployer --network testnet --fund`; stored outside the repo in the CLI's identity folder, never committed). Testnet only, no value, $0.

| Item | Value |
|---|---|
| Network | `stellar:testnet` (`Test SDF Network ; September 2015`) |
| Contract id | `CAGID4DCA5IY7REZYHJWSTHU3BPE5VABPTRW3ASMNW3U7JK2XTTLE2MQ` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CAGID4DCA5IY7REZYHJWSTHU3BPE5VABPTRW3ASMNW3U7JK2XTTLE2MQ |
| Stellar Lab | https://lab.stellar.org/r/testnet/contract/CAGID4DCA5IY7REZYHJWSTHU3BPE5VABPTRW3ASMNW3U7JK2XTTLE2MQ |
| Wasm hash (sha256 of `x402_settle.wasm`, 3,353 bytes) | `d78b356e79de52671439ada09bd714e042df3eed6511657de001859763bb12f1` |
| Wasm upload tx | https://stellar.expert/explorer/testnet/tx/382eb9c975c38c4e7485e76876c7f1f1a454cf2f1310222c43677054dfbf79b7 |
| Create-contract (deploy) tx | https://stellar.expert/explorer/testnet/tx/4f176960c17d7adafe7dd508549efde48a755ac9a11edc66839aafa93c4a3871 |
| Deployer account | `GCKZRAOJRDVZMFFWIOAFFZJLTBWHG6W7AJFYX5RXUUBKIWPMOZKXH3VQ` (friendbot-funded testnet key, no other use) |
| Toolchain | rustc 1.93.0, soroban-sdk 29.0.1, stellar-cli 28.1.0, target `wasm32v1-none` |

Reproduce the hash: `stellar contract build` in `contracts/x402-settle` at this commit, then `sha256sum target/wasm32v1-none/release/x402_settle.wasm`. The contract meta below also records the exact Rust, SDK and CLI versions.

## Verification against the live network (pasted verbatim)

```
$ stellar contract info interface --id CAGID4DCA5IY7REZYHJWSTHU3BPE5VABPTRW3ASMNW3U7JK2XTTLE2MQ --network testnet
ℹ️  Network: Test SDF Network ; September 2015
🌎 Downloading contract spec: CAGID4DCA5IY7REZYHJWSTHU3BPE5VABPTRW3ASMNW3U7JK2XTTLE2MQ
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

$ stellar contract info meta --id CAGID4DCA5IY7REZYHJWSTHU3BPE5VABPTRW3ASMNW3U7JK2XTTLE2MQ --network testnet
ℹ️  Network: Test SDF Network ; September 2015
🌎 Downloading contract spec: CAGID4DCA5IY7REZYHJWSTHU3BPE5VABPTRW3ASMNW3U7JK2XTTLE2MQ
Contract meta:
 • rsver: 1.93.0 (Rust version)
 • rssdkver: 29.0.1#e1671a0cb58d4b8c0bb8de115caf080ca01676e8 (Soroban SDK version and its commit hash)
 • rssdk_spec_shaking: 2
 • cliver: 28.1.0#c0f4d0da891bbf214c08b8c5035ae6db80e9a3bd

$ stellar contract invoke --id CAGID4DCA5IY7REZYHJWSTHU3BPE5VABPTRW3ASMNW3U7JK2XTTLE2MQ --source t2-deployer --network testnet -- version
ℹ️  Simulation identified as read-only. Send by rerunning with `--send=yes`.
1

$ stellar contract fetch --id CAGID4DCA5IY7REZYHJWSTHU3BPE5VABPTRW3ASMNW3U7JK2XTTLE2MQ --network testnet --out-file fetched.wasm && sha256sum fetched.wasm
d78b356e79de52671439ada09bd714e042df3eed6511657de001859763bb12f1 *fetched.wasm
```

The fetched wasm hashes to the same value as the local build, so the code at this address is the code in this directory at this commit.

## Superseded testnet deployments (same day, not to be used)

- `CA5LF4WBEXMFGX4BQCSLVEXVV6U3AUIQ55KNTSIQVD3HDEXAEEWFE5BC` (wasm `ce19281423356429fa221187720bba45df945f1b1ea1615eb9fff07b5ec37b6e`, deploy tx `049b77216553aad3d178fc430cc5b82c22078ea78c38dc1cb64f5160b1a5534c`): first build, carried an optional flat facilitator fee split. Withdrawn by Operator decision the same afternoon (transaction-based compensation is forbidden); never wired, never quoted. It stays on testnet because contracts cannot be removed; nothing should reference it.
- The Node integration test deploys its own fresh instance on every run unless `X402_SETTLE_CONTRACT_ID` is set; those instances are throwaway.

## What this record is not

Not a mainnet deployment, not a receipt that any facilitator calls this contract, and not an audit. Mainnet is a separate milestone with Kevan's explicit go.
