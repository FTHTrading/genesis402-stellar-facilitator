#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, Event as _, IntoVal,
};

const START_LEDGER: u32 = 1_000;

struct Fixture {
    env: Env,
    id: Address,
    token: Address,
    payer: Address,
    seller: Address,
    facilitator: Address,
}

impl Fixture {
    fn client(&self) -> X402SettleClient<'_> {
        X402SettleClient::new(&self.env, &self.id)
    }
}

fn setup(payer_balance: i128) -> Fixture {
    let env = Env::default();
    env.ledger().with_mut(|l| l.sequence_number = START_LEDGER);
    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin).address();
    let payer = Address::generate(&env);
    let seller = Address::generate(&env);
    let facilitator = Address::generate(&env);
    env.mock_all_auths();
    StellarAssetClient::new(&env, &token).mint(&payer, &payer_balance);
    let id = env.register(X402Settle, ());
    Fixture { env, id, token, payer, seller, facilitator }
}

fn nonce(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn balance(env: &Env, token: &Address, who: &Address) -> i128 {
    TokenClient::new(env, token).balance(who)
}

#[test]
fn settles_once_moves_amount_and_marks_nonce() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 1);
    assert!(!c.is_settled(&f.payer, &n));

    c.settle(&f.payer, &f.seller, &f.token, &1_000_000, &0, &n, &(START_LEDGER + 100), &f.facilitator);

    assert_eq!(balance(&f.env, &f.token, &f.payer), 9_000_000);
    assert_eq!(balance(&f.env, &f.token, &f.seller), 1_000_000);
    assert_eq!(balance(&f.env, &f.token, &f.facilitator), 0);
    assert!(c.is_settled(&f.payer, &n));
}

#[test]
fn emits_settled_event() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 2);
    c.settle(&f.payer, &f.seller, &f.token, &250_000, &0, &n, &(START_LEDGER + 10), &f.facilitator);

    let ours = f.env.events().all().filter_by_contract(&f.id);
    let expected = Settled {
        payer: f.payer.clone(),
        seller: f.seller.clone(),
        token: f.token.clone(),
        amount: 250_000,
        fee: 0,
        nonce: n,
        ledger: START_LEDGER,
    };
    assert_eq!(ours, [expected.to_xdr(&f.env, &f.id)]);
}

#[test]
fn replay_of_same_payer_nonce_is_refused() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 3);
    c.settle(&f.payer, &f.seller, &f.token, &1_000_000, &0, &n, &(START_LEDGER + 100), &f.facilitator);

    let second = c.try_settle(&f.payer, &f.seller, &f.token, &1_000_000, &0, &n, &(START_LEDGER + 100), &f.facilitator);
    assert_eq!(second, Err(Ok(Error::AlreadySettled)));
    // Nothing moved the second time.
    assert_eq!(balance(&f.env, &f.token, &f.seller), 1_000_000);
    assert_eq!(balance(&f.env, &f.token, &f.payer), 9_000_000);
}

#[test]
fn replay_refused_even_with_different_amount_or_seller() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 4);
    let other_seller = Address::generate(&f.env);
    c.settle(&f.payer, &f.seller, &f.token, &1_000_000, &0, &n, &(START_LEDGER + 100), &f.facilitator);
    let r = c.try_settle(&f.payer, &other_seller, &f.token, &5, &0, &n, &(START_LEDGER + 100), &f.facilitator);
    assert_eq!(r, Err(Ok(Error::AlreadySettled)));
}

#[test]
fn same_nonce_from_a_different_payer_is_independent() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 5);
    let payer2 = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&payer2, &1_000_000);
    c.settle(&f.payer, &f.seller, &f.token, &1_000_000, &0, &n, &(START_LEDGER + 100), &f.facilitator);
    c.settle(&payer2, &f.seller, &f.token, &1_000_000, &0, &n, &(START_LEDGER + 100), &f.facilitator);
    assert!(c.is_settled(&f.payer, &n));
    assert!(c.is_settled(&payer2, &n));
    assert_eq!(balance(&f.env, &f.token, &f.seller), 2_000_000);
}

#[test]
fn expired_quote_is_refused() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 6);
    let r = c.try_settle(&f.payer, &f.seller, &f.token, &1_000_000, &0, &n, &(START_LEDGER - 1), &f.facilitator);
    assert_eq!(r, Err(Ok(Error::Expired)));
    assert!(!c.is_settled(&f.payer, &n));
    assert_eq!(balance(&f.env, &f.token, &f.payer), 10_000_000);
}

#[test]
fn expiry_equal_to_current_ledger_is_still_valid() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 7);
    c.settle(&f.payer, &f.seller, &f.token, &1, &0, &n, &START_LEDGER, &f.facilitator);
    assert!(c.is_settled(&f.payer, &n));
}

#[test]
fn expiry_too_far_in_the_future_is_refused() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 8);
    let r = c.try_settle(
        &f.payer,
        &f.seller,
        &f.token,
        &1,
        &0,
        &n,
        &(START_LEDGER + MAX_EXPIRY_WINDOW_LEDGERS + 1),
        &f.facilitator,
    );
    assert_eq!(r, Err(Ok(Error::ExpiryTooFar)));
    // Exactly at the window edge is accepted.
    c.settle(&f.payer, &f.seller, &f.token, &1, &0, &n, &(START_LEDGER + MAX_EXPIRY_WINDOW_LEDGERS), &f.facilitator);
}

#[test]
fn seller_cannot_settle_without_payer_auth() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.sequence_number = START_LEDGER);
    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin).address();
    let payer = Address::generate(&env);
    let seller = Address::generate(&env);
    let facilitator = Address::generate(&env);
    env.mock_all_auths();
    StellarAssetClient::new(&env, &token).mint(&payer, &10_000_000);
    let id = env.register(X402Settle, ());
    let client = X402SettleClient::new(&env, &id);
    let n = nonce(&env, 9);
    let amount: i128 = 1_000_000;
    let fee: i128 = 0;
    let expiry = START_LEDGER + 100;

    // Only the seller "signs" the settle invocation; the payer never authorizes it.
    env.mock_auths(&[MockAuth {
        address: &seller,
        invoke: &MockAuthInvoke {
            contract: &id,
            fn_name: "settle",
            args: (&payer, &seller, &token, amount, fee, n.clone(), expiry, &facilitator).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let r = client.try_settle(&payer, &seller, &token, &amount, &fee, &n, &expiry, &facilitator);
    assert!(r.is_err(), "settle without payer auth must fail, got {:?}", r);
    assert!(!client.is_settled(&payer, &n));
    assert_eq!(balance(&env, &token, &payer), 10_000_000);
    assert_eq!(balance(&env, &token, &seller), 0);
}

#[test]
fn zero_amount_is_refused() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 10);
    let r = c.try_settle(&f.payer, &f.seller, &f.token, &0, &0, &n, &(START_LEDGER + 100), &f.facilitator);
    assert_eq!(r, Err(Ok(Error::InvalidAmount)));
    assert!(!c.is_settled(&f.payer, &n));
}

#[test]
fn negative_amount_is_refused() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 11);
    let r = c.try_settle(&f.payer, &f.seller, &f.token, &-5, &0, &n, &(START_LEDGER + 100), &f.facilitator);
    assert_eq!(r, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn insufficient_balance_is_refused_and_nonce_not_consumed() {
    let f = setup(500_000);
    let c = f.client();
    let n = nonce(&f.env, 12);
    let r = c.try_settle(&f.payer, &f.seller, &f.token, &1_000_000, &0, &n, &(START_LEDGER + 100), &f.facilitator);
    assert!(r.is_err(), "token transfer must fail on insufficient balance, got {:?}", r);
    // The whole invocation rolls back: nonce not marked, balances unchanged.
    assert!(!c.is_settled(&f.payer, &n));
    assert_eq!(balance(&f.env, &f.token, &f.payer), 500_000);
    assert_eq!(balance(&f.env, &f.token, &f.seller), 0);
}

#[test]
fn flat_fee_split_is_exact() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 13);
    // Quote: amount 1_000_000 (what the payer pays), flat fee 12_345 to the facilitator.
    c.settle(&f.payer, &f.seller, &f.token, &1_000_000, &12_345, &n, &(START_LEDGER + 100), &f.facilitator);
    // Capture before any further invocation: the test env keeps only the last call's events.
    let ours = f.env.events().all().filter_by_contract(&f.id);
    assert_eq!(balance(&f.env, &f.token, &f.payer), 10_000_000 - 1_000_000);
    assert_eq!(balance(&f.env, &f.token, &f.seller), 1_000_000 - 12_345);
    assert_eq!(balance(&f.env, &f.token, &f.facilitator), 12_345);
    // Conservation: the single debit equals the two credits.
    assert_eq!(balance(&f.env, &f.token, &f.seller) + balance(&f.env, &f.token, &f.facilitator), 1_000_000);
    let expected = Settled {
        payer: f.payer.clone(),
        seller: f.seller.clone(),
        token: f.token.clone(),
        amount: 1_000_000,
        fee: 12_345,
        nonce: n,
        ledger: START_LEDGER,
    };
    assert_eq!(ours, [expected.to_xdr(&f.env, &f.id)]);
}

#[test]
fn fee_of_one_stroop_on_a_tiny_amount_is_exact() {
    let f = setup(10);
    let c = f.client();
    let n = nonce(&f.env, 14);
    c.settle(&f.payer, &f.seller, &f.token, &2, &1, &n, &(START_LEDGER + 100), &f.facilitator);
    assert_eq!(balance(&f.env, &f.token, &f.payer), 8);
    assert_eq!(balance(&f.env, &f.token, &f.seller), 1);
    assert_eq!(balance(&f.env, &f.token, &f.facilitator), 1);
}

#[test]
fn zero_fee_makes_no_facilitator_transfer() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 15);
    c.settle(&f.payer, &f.seller, &f.token, &1_000_000, &0, &n, &(START_LEDGER + 100), &f.facilitator);
    // Exactly one token event (the seller transfer); a zero fee must not emit a second transfer.
    let transfers = f.env.events().all().filter_by_contract(&f.token).events().len();
    assert_eq!(transfers, 1);
    assert_eq!(balance(&f.env, &f.token, &f.facilitator), 0);
}

#[test]
fn negative_fee_is_refused() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 16);
    let r = c.try_settle(&f.payer, &f.seller, &f.token, &1_000_000, &-1, &n, &(START_LEDGER + 100), &f.facilitator);
    assert_eq!(r, Err(Ok(Error::InvalidFee)));
}

#[test]
fn fee_equal_or_above_amount_is_refused() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 17);
    let r = c.try_settle(&f.payer, &f.seller, &f.token, &1_000, &1_000, &n, &(START_LEDGER + 100), &f.facilitator);
    assert_eq!(r, Err(Ok(Error::InvalidFee)));
    let r = c.try_settle(&f.payer, &f.seller, &f.token, &1_000, &1_001, &n, &(START_LEDGER + 100), &f.facilitator);
    assert_eq!(r, Err(Ok(Error::InvalidFee)));
    assert!(!c.is_settled(&f.payer, &n));
}

#[test]
fn seller_equal_to_payer_is_refused() {
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 18);
    let r = c.try_settle(&f.payer, &f.payer, &f.token, &1_000, &0, &n, &(START_LEDGER + 100), &f.facilitator);
    assert_eq!(r, Err(Ok(Error::InvalidParty)));
}

#[test]
fn nonce_stays_readable_after_the_quote_expired() {
    // The nonce entry's TTL is extended so is_settled stays readable for recovery after expiry.
    let f = setup(10_000_000);
    let c = f.client();
    let n = nonce(&f.env, 19);
    c.settle(&f.payer, &f.seller, &f.token, &1, &0, &n, &(START_LEDGER + 5), &f.facilitator);
    f.env.ledger().with_mut(|l| l.sequence_number = START_LEDGER + 5 + 1_000);
    assert!(c.is_settled(&f.payer, &n));
}

#[test]
fn version_is_one() {
    let f = setup(1);
    assert_eq!(f.client().version(), 1);
}
