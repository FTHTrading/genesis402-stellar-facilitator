//! x402-settle: settlement contract for x402 `exact` payments on Stellar.
//!
//! One function moves money: `settle`. The payer authorizes exactly one
//! invocation (contract, function, every argument) with `require_auth`; the
//! contract then transfers exactly `amount` of `token` from the payer to the
//! seller and records a `Settlement { seller, token, amount, ledger }` under
//! `(payer, nonce)` in persistent storage, so the same quote can never settle
//! twice, from any process, on any facilitator, and so a seller can read back
//! what was actually settled and compare it with its own quote.
//!
//! No fee logic, by design: a per-settlement platform fee would be
//! transaction-based compensation, which UnyKorn LLC's standing rule forbids.
//! The facilitator's transaction fee is paid by the envelope source outside
//! the contract; its revenue, if any, is a flat subscription outside the chain.
//!
//! Deliberately admin-less: there is no upgrade key, no pause switch and no
//! owner. v1 is immutable at its address; a v2 is a new contract at a new
//! address that sellers opt into by quoting it. See README.md.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env,
};

/// Largest accepted distance between the current ledger and `expiry_ledger`
/// (about 58 days at 5 s per ledger). Bounds how long a signed quote can
/// stay valid and keeps the nonce TTL well under any network's maximum entry TTL.
pub const MAX_EXPIRY_WINDOW_LEDGERS: u32 = 1_000_000;

/// Requested extra lifetime (in ledgers, about 7 days at 5 s) for the
/// settlement record beyond the quote expiry, so `settlement` / `is_settled`
/// stay readable for recovery. The host clamps `extend_ttl` at the network's
/// `max_entry_ttl - 1` from the current ledger (observed in the SDK test env;
/// the live testnet value is UNVERIFIED here), so for a long quote window the
/// entry can be archived before the quote expires. Archival never re-opens a
/// quote: touching an archived key fails until it is restored
/// (`RestoreFootprintOp`), and once restored the record is present again and
/// `settle` answers `AlreadySettled`; after `expiry_ledger` the `Expired` check
/// refuses first. Reading a record after archival therefore needs a restore.
pub const NONCE_RECOVERY_LEDGERS: u32 = 120_960;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `(payer, nonce)` was already settled through this contract.
    AlreadySettled = 1,
    /// `expiry_ledger` is below the current ledger sequence.
    Expired = 2,
    /// `amount` is zero or negative.
    InvalidAmount = 3,
    /// `expiry_ledger` is more than `MAX_EXPIRY_WINDOW_LEDGERS` ahead.
    ExpiryTooFar = 4,
    /// `seller == payer`.
    InvalidParty = 5,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Settlement record, keyed by payer and the quote nonce.
    Settled(Address, BytesN<32>),
}

/// What was settled under `(payer, nonce)`. A seller delivers only when
/// `seller`, `token` and `amount` equal its own quote; the nonce alone proves
/// nothing about who was paid.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub seller: Address,
    pub token: Address,
    pub amount: i128,
    pub ledger: u32,
}

/// Emitted once per successful `settle`. Topics: `"settled"`, payer, seller.
#[contractevent(topics = ["settled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settled {
    #[topic]
    pub payer: Address,
    #[topic]
    pub seller: Address,
    pub token: Address,
    pub amount: i128,
    pub nonce: BytesN<32>,
    pub ledger: u32,
}

#[contract]
pub struct X402Settle;

#[contractimpl]
impl X402Settle {
    /// Settle one x402 quote: move exactly `amount` of `token` from `payer` to `seller`.
    ///
    /// * `payer` must authorize this exact invocation (and, through the auth
    ///   tree, the token transfer it causes).
    /// * `amount` is what the payer pays, in the token's atomic units; the
    ///   seller receives all of it.
    /// * `nonce` is the quote nonce; `(payer, nonce)` can settle once.
    /// * `expiry_ledger` is inclusive: the call is valid while
    ///   `current_ledger <= expiry_ledger`.
    pub fn settle(
        env: Env,
        payer: Address,
        seller: Address,
        token: Address,
        amount: i128,
        nonce: BytesN<32>,
        expiry_ledger: u32,
    ) -> Result<(), Error> {
        payer.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if seller == payer {
            return Err(Error::InvalidParty);
        }

        let current = env.ledger().sequence();
        if expiry_ledger < current {
            return Err(Error::Expired);
        }
        let window = expiry_ledger - current;
        if window > MAX_EXPIRY_WINDOW_LEDGERS {
            return Err(Error::ExpiryTooFar);
        }

        let key = DataKey::Settled(payer.clone(), nonce.clone());
        let store = env.storage().persistent();
        if store.has(&key) {
            return Err(Error::AlreadySettled);
        }
        // Record before moving funds; a failed transfer rolls the whole invocation back.
        let record = Settlement { seller: seller.clone(), token: token.clone(), amount, ledger: current };
        store.set(&key, &record);
        let live_for = window.saturating_add(NONCE_RECOVERY_LEDGERS);
        store.extend_ttl(&key, live_for, live_for);

        token::TokenClient::new(&env, &token).transfer(&payer, &seller, &amount);

        Settled { payer, seller, token, amount, nonce, ledger: current }.publish(&env);
        Ok(())
    }

    /// The settlement recorded under `(payer, nonce)`, or `None`. This is what
    /// a seller or facilitator reads to decide delivery: compare `seller`,
    /// `token` and `amount` with the quote.
    pub fn settlement(env: Env, payer: Address, nonce: BytesN<32>) -> Option<Settlement> {
        env.storage().persistent().get(&DataKey::Settled(payer, nonce))
    }

    /// `true` once `(payer, nonce)` is consumed. It says only that: the payer
    /// may have settled any amount to any address under this nonce. Use
    /// `settlement` to learn what was paid to whom.
    pub fn is_settled(env: Env, payer: Address, nonce: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Settled(payer, nonce))
    }

    /// Contract interface version. v1 has no upgrade path; a v2 is a new address.
    pub fn version() -> u32 {
        1
    }
}

mod test;
