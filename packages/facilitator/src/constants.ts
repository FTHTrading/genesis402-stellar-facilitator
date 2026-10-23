import { Networks } from "@stellar/stellar-sdk";

/** CAIP-2 identifiers for Stellar (https://namespaces.chainagnostic.org/stellar/caip2). */
export const STELLAR_TESTNET = "stellar:testnet";
export const STELLAR_PUBNET = "stellar:pubnet";

export const NETWORK_PASSPHRASES: Readonly<Record<string, string>> = {
  [STELLAR_TESTNET]: Networks.TESTNET,
  [STELLAR_PUBNET]: Networks.PUBLIC,
};

export const DEFAULT_RPC_URLS: Readonly<Record<string, string>> = {
  [STELLAR_TESTNET]: "https://soroban-testnet.stellar.org",
};

export const DEFAULT_HORIZON_URLS: Readonly<Record<string, string>> = {
  [STELLAR_TESTNET]: "https://horizon-testnet.stellar.org",
  [STELLAR_PUBNET]: "https://horizon.stellar.org",
};

export const FRIENDBOT_URL = "https://friendbot.stellar.org";

/**
 * Circle USDC Stellar Asset Contract addresses.
 * Testnet issuer GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 (home_domain centre.io),
 * verified on Horizon testnet 2026-10-23. Pubnet address per the x402 Stellar scheme spec.
 */
export const USDC_SAC: Readonly<Record<string, string>> = {
  [STELLAR_TESTNET]: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  [STELLAR_PUBNET]: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
};

export const USDC_DECIMALS = 7;

export const SUPPORTED_X402_VERSION = 2;
export const SCHEME_EXACT = "exact";

/** Fallback when the network's ledger close time cannot be measured. */
export const DEFAULT_ESTIMATED_LEDGER_SECONDS = 5;
/** Tolerance (in ledgers) for RPC skew when checking expiration upper bound. */
export const SIGNATURE_EXPIRATION_LEDGER_TOLERANCE = 2;
/** Safety ceiling for the simulation-derived settlement fee (stroops). */
export const DEFAULT_MAX_TRANSACTION_FEE_STROOPS = 50_000;
/** Inclusion fee bid added on top of the resource fee (stroops). */
export const DEFAULT_INCLUSION_FEE_STROOPS = 100;
export const DEFAULT_TIMEOUT_SECONDS = 60;

export const STELLAR_ACCOUNT_REGEX = /^G[A-Z2-7]{55}$/;
export const STELLAR_CONTRACT_REGEX = /^C[A-Z2-7]{55}$/;
export const STELLAR_DESTINATION_REGEX = /^(?:[GC][A-Z2-7]{55}|M[A-Z2-7]{68})$/;

export function isStellarNetwork(network: string): boolean {
  return network in NETWORK_PASSPHRASES;
}

export function passphraseFor(network: string): string {
  const p = NETWORK_PASSPHRASES[network];
  if (!p) throw new Error(`Unknown Stellar network: ${network}`);
  return p;
}

export function explorerTxUrl(network: string, hash: string): string {
  const seg = network === STELLAR_PUBNET ? "public" : "testnet";
  return `https://stellar.expert/explorer/${seg}/tx/${hash}`;
}
