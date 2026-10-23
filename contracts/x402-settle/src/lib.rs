//! x402-settle: settlement contract for x402 `exact` payments on Stellar.
//!
//! One function moves money: `settle`. The payer authorizes exactly one
//! invocation (contract, function, every argument) with `require_auth`; the
//! contract then transfers `amount` of `token` from the payer to the seller,
//! optionally splitting a flat `fee` (never a percentage) to the facilitator,
//! and records `(payer, nonce)` in persistent storage so the same quote can
//! never settle twice, from any process, on any facilitator.
//!
//! Deliberately admin-less: there is no upgrade key, no pause switch, no fee
//! setter and no owner. v1 is immutable at its address; a v2 is a new contract
//! at a new address that sellers opt into by quoting it. See README.md.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env,
};

/// Largest accepted distance between the current ledger and `expiry_ledger`
/// (about 58 days at 5 s per ledger). Bounds how long a signed quote can
/// stay valid and keeps the nonce TTL well under any network's maximum entry TTL.
pub const MAX_EXPIRY_WINDOW_LEDGERS: u32 = 1_000_000;

/// How long (in ledgers, about 7 days at 5 s) a consumed nonce stays readable
/// beyond its quote expiry so `is_settled` can be used for recovery. After the
/// entry is archived a replay is still refused, because its `expiry_ledger`
/// is then in the past.
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
    /// `fee` is negative, or not strictly smaller than `amount`.
    InvalidFee = 4,
    /// `expiry_ledger` is more than `MAX_EXPIRY_WINDOW_LEDGERS` ahead.
    ExpiryTooFar = 5,
    /// `seller == payer`, or `facilitator == payer` while a fee is due.
    InvalidParty = 6,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Consumed nonce, keyed by payer and the quote nonce.
    Settled(Address, BytesN<32>),
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
    pub fee: i128,
    pub nonce: BytesN<32>,
    pub ledger: u32,
}

#[contract]
pub struct X402Settle;

#[contractimpl]
impl X402Settle {
    /// Settle one x402 quote.
    ///
    /// * `payer` must authorize this exact invocation (and, through the auth
    ///   tree, the token transfers it causes).
    /// * `amount` is what the payer pays, in the token's atomic units.
    /// * `fee` is a flat amount out of `amount` that goes to `facilitator`;
    ///   `0` means no facilitator transfer at all. The seller receives
    ///   `amount - fee`.
    /// * `nonce` is the quote nonce; `(payer, nonce)` can settle once.
    /// * `expiry_ledger` is inclusive: the call is valid while
    ///   `current_ledger <= expiry_ledger`.
    #[allow(clippy::too_many_arguments)]
    pub fn settle(
        env: Env,
        payer: Address,
        seller: Address,
        token: Address,
        amount: i128,
        fee: i128,
        nonce: BytesN<32>,
        expiry_ledger: u32,
        facilitator: Address,
    ) -> Result<(), Error> {
        payer.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if fee < 0 || fee >= amount {
            return Err(Error::InvalidFee);
        }
        if seller == payer || (fee > 0 && facilitator == payer) {
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
        // Mark before moving funds; a failed transfer rolls the whole invocation back.
        store.set(&key, &true);
        let live_for = window.saturating_add(NONCE_RECOVERY_LEDGERS);
        store.extend_ttl(&key, live_for, live_for);

        let client = token::TokenClient::new(&env, &token);
        // `fee < amount` was checked above, so this cannot underflow.
        client.transfer(&payer, &seller, &(amount - fee));
        if fee > 0 {
            client.transfer(&payer, &facilitator, &fee);
        }

        Settled { payer, seller, token, amount, fee, nonce, ledger: current }.publish(&env);
        Ok(())
    }

    /// `true` once `(payer, nonce)` has settled through this contract.
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
