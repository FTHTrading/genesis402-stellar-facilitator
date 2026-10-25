/**
 * Every sentence the server can show a visitor lives here, so the copy check
 * (test/copy-and-bundle.test.ts) can scan it against the forbidden-word list.
 */
export const MSG = {
  addressMissing: "Paste a Stellar testnet address (it starts with G).",
  addressInvalid: "That is not a valid Stellar address. It should be 56 characters and start with G.",
  addressMuxed: "Muxed addresses (starting with M) are not supported here. Paste the plain G address.",
  addressContract: "Contract addresses (starting with C) cannot receive from this faucet. Paste a G account address.",
  addressIsSecret:
    "That looks like a SECRET key, not an address. Never paste a secret key into a website. Paste the public G address.",
  accountNotFound:
    "This account does not exist on testnet yet. Use the Get test XLM card to create and fund it, then try again.",
  noTrustline: (code: string, issuer: string) =>
    `This account has no trustline for ${code}. Add one with a change_trust operation for asset ${code} issued by ${issuer}, then press Obtain again. The Make me a test wallet button does this for you.`,
  trustlineFull: (code: string) =>
    `The ${code} trustline on this account has no room for 1,000 more. Raise its limit with change_trust and try again.`,
  faucetEmpty: "The G402T faucet is empty right now. Please try again later.",
  notConfigured: "The G402T faucet is not set up on this server. Test XLM still works.",
  horizonUnavailable: "The Stellar testnet server (Horizon) did not answer. Nothing was sent. Please try again in a minute.",
  friendbotUnavailable: "Stellar Friendbot did not answer. Nothing was sent. Please try again in a minute.",
  submitFailed: "The testnet rejected the payment. Nothing was sent. Please try again in a minute.",
  submitPending:
    "The payment may have been sent; the testnet has not confirmed it yet. Check the transaction link before trying again.",
  horizonBusy: "The Stellar testnet server (Horizon) is busy, try again shortly. No payment was made.",
  alreadyFunded:
    "Friendbot declined this address (it usually means the account is already funded). Nothing was sent.",
  rateLimited: (what: string, scope: "address" | "ip" | "global" | "attempts", retry: string) =>
    scope === "address"
      ? `This address already received ${what} in the last 24 hours. Try again in ${retry}.`
      : scope === "ip"
        ? `This network already received ${what} in the last 24 hours. Try again in ${retry}.`
        : scope === "global"
          ? `The faucet has reached its daily limit for ${what}. It opens again at midnight UTC, in ${retry}.`
          : `Too many tries from this network in the last hour. Nothing was sent. Try again in ${retry}.`,
  badJson: "Send a JSON body like {\"address\": \"G...\"}.",
  needJson: "Send the request as application/json.",
  tooLarge: "Request body is too large.",
  notFound: "No such endpoint.",
  methodNotAllowed: "Use POST for this endpoint.",
  internal: "Something went wrong on our side. Nothing was sent.",
} as const;

export function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.ceil((s % 3600) / 60);
  if (h === 0) return `${Math.max(1, m)}m`;
  return m === 0 || m === 60 ? `${h + (m === 60 ? 1 : 0)}h` : `${h}h ${m}m`;
}
