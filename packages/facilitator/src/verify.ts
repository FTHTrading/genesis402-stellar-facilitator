import {
  Address,
  Keypair,
  Transaction,
  TransactionBuilder,
  buildAuthorizationEntryPreimage,
  hash,
  inspectAuthEntry,
  scValToNative,
  type Operation,
  type xdr,
} from "@stellar/stellar-sdk";
import {
  SCHEME_EXACT,
  SIGNATURE_EXPIRATION_LEDGER_TOLERANCE,
  SUPPORTED_X402_VERSION,
  isStellarNetwork,
} from "./constants.js";
import type { NonceStore } from "./nonce-store.js";
import { ExactStellarPayloadSchema, type PaymentPayload, type PaymentRequirements } from "./types.js";

export interface StaticContext {
  networkPassphrase: string;
  /** Every address the facilitator controls (settlement signers, fee-bump signer). */
  facilitatorAddresses: ReadonlySet<string>;
  currentLedger: number;
  estimatedLedgerSeconds: number;
  nonceStore: NonceStore;
}

export type StaticResult =
  | {
      ok: true;
      payer: string;
      nonce: string;
      expirationLedger: number;
      transaction: Transaction;
      invokeOp: Operation.InvokeHostFunction;
      authEntry: xdr.SorobanAuthorizationEntry;
    }
  | { ok: false; reason: string; message?: string; payer?: string };

function fail(reason: string, payer?: string, message?: string): StaticResult {
  return { ok: false, reason, ...(payer ? { payer } : {}), ...(message ? { message } : {}) };
}

/**
 * Address credentials for the legacy `sorobanCredentialsAddress` arm and the
 * CAP-71 `sorobanCredentialsAddressV2` arm. Source-account and delegated
 * credentials return undefined and are rejected by the caller.
 */
export function addressCredentials(
  creds: xdr.SorobanCredentials,
): xdr.SorobanAddressCredentials | undefined {
  if (creds.type === "sorobanCredentialsAddress") return creds.address;
  if (creds.type === "sorobanCredentialsAddressV2") return creds.addressV2;
  return undefined;
}

/**
 * Every check that needs no network access, in the order the x402 Stellar
 * `exact` scheme lists them: protocol fields, transaction structure, transfer
 * arguments, facilitator safety, auth entry structure, expiry window, local
 * Ed25519 verification of the payer's signature, and nonce replay.
 *
 * Simulation and event checks happen afterwards in `StellarFacilitator`.
 */
export function verifyStatic(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  ctx: StaticContext,
): StaticResult {
  if (payload.x402Version !== SUPPORTED_X402_VERSION) return fail("invalid_x402_version");
  if (payload.accepted.scheme !== SCHEME_EXACT || requirements.scheme !== SCHEME_EXACT) {
    return fail("unsupported_scheme");
  }
  if (payload.accepted.network !== requirements.network) return fail("network_mismatch");
  if (!isStellarNetwork(requirements.network)) return fail("invalid_network");
  if (!/^\d+$/.test(requirements.amount)) return fail("invalid_exact_stellar_payload_wrong_amount");

  const parsed = ExactStellarPayloadSchema.safeParse(payload.payload);
  if (!parsed.success) return fail("invalid_exact_stellar_payload_malformed");

  let transaction: Transaction;
  try {
    const env = TransactionBuilder.fromXDR(parsed.data.transaction, ctx.networkPassphrase);
    if (!(env instanceof Transaction)) return fail("invalid_exact_stellar_payload_malformed");
    transaction = env;
  } catch {
    return fail("invalid_exact_stellar_payload_malformed");
  }

  if (transaction.operations.length !== 1) {
    return fail("invalid_exact_stellar_payload_wrong_operation");
  }
  const operation = transaction.operations[0]!;
  if (operation.type !== "invokeHostFunction") {
    return fail("invalid_exact_stellar_payload_wrong_operation");
  }
  if (
    ctx.facilitatorAddresses.has(transaction.source) ||
    ctx.facilitatorAddresses.has(operation.source ?? "")
  ) {
    return fail("invalid_exact_stellar_payload_unsafe_tx_or_op_source");
  }

  const invokeOp = operation as Operation.InvokeHostFunction;
  const func = invokeOp.func;
  if (func.type !== "hostFunctionTypeInvokeContract") {
    return fail("invalid_exact_stellar_payload_wrong_operation");
  }
  const invokeArgs = func.invokeContract;
  const contractAddress = Address.fromScAddress(invokeArgs.contractAddress).toString();
  if (contractAddress !== requirements.asset) return fail("invalid_exact_stellar_payload_wrong_asset");
  const functionName = invokeArgs.functionName.toString();
  const args = invokeArgs.args;
  if (functionName !== "transfer" || args.length !== 3) {
    return fail("invalid_exact_stellar_payload_wrong_function_name");
  }

  let from: unknown;
  let to: unknown;
  let amount: unknown;
  try {
    from = scValToNative(args[0]!);
    to = scValToNative(args[1]!);
    amount = scValToNative(args[2]!);
  } catch {
    return fail("invalid_exact_stellar_payload_malformed");
  }
  if (typeof from !== "string" || typeof to !== "string" || typeof amount !== "bigint") {
    return fail("invalid_exact_stellar_payload_malformed");
  }
  if (ctx.facilitatorAddresses.has(from)) {
    return fail("invalid_exact_stellar_payload_facilitator_is_payer");
  }
  if (to !== requirements.payTo) return fail("invalid_exact_stellar_payload_wrong_recipient", from);
  if (amount !== BigInt(requirements.amount)) {
    return fail("invalid_exact_stellar_payload_wrong_amount", from);
  }

  const auth = invokeOp.auth ?? [];
  if (auth.length === 0) return fail("invalid_exact_stellar_payload_no_auth_entries", from);

  const expectedInvocation = invokeArgs.toXDR("base64");
  let payerEntry: xdr.SorobanAuthorizationEntry | undefined;
  for (const entry of auth) {
    const creds = addressCredentials(entry.credentials);
    if (!creds) return fail("invalid_exact_stellar_payload_unsupported_credential_type", from);
    const authAddress = Address.fromScAddress(creds.address).toString();
    if (ctx.facilitatorAddresses.has(authAddress)) {
      return fail("invalid_exact_stellar_payload_facilitator_in_auth", from);
    }
    const root = entry.rootInvocation;
    if (root.subInvocations.length > 0) {
      return fail("invalid_exact_stellar_payload_has_subinvocations", from);
    }
    if (
      root.function.type !== "sorobanAuthorizedFunctionTypeContractFn" ||
      root.function.contractFn.toXDR("base64") !== expectedInvocation
    ) {
      return fail("invalid_exact_stellar_payload_auth_mismatch", from);
    }
    if (authAddress === from) {
      if (payerEntry) return fail("invalid_exact_stellar_payload_duplicate_payer_auth", from);
      payerEntry = entry;
    }
  }
  if (!payerEntry) return fail("invalid_exact_stellar_payload_missing_payer_auth", from);

  const creds = addressCredentials(payerEntry.credentials)!;
  const expirationLedger = creds.signatureExpirationLedger;
  if (expirationLedger <= ctx.currentLedger) {
    return fail("invalid_exact_stellar_signature_expired", from);
  }
  const maxLedger =
    ctx.currentLedger + Math.ceil(requirements.maxTimeoutSeconds / ctx.estimatedLedgerSeconds);
  if (expirationLedger > maxLedger + SIGNATURE_EXPIRATION_LEDGER_TOLERANCE) {
    return fail("invalid_exact_stellar_signature_expiration_too_far", from);
  }

  const info = inspectAuthEntry(payerEntry);
  const signer = info.signers[0];
  const signatures = signer?.signatures ?? null;
  if (!signer?.signed || !signatures || signatures.length !== 1) {
    return fail("invalid_exact_stellar_payload_bad_signature", from);
  }
  const sig = signatures[0]!;
  let signatureValid = false;
  try {
    const preimage = buildAuthorizationEntryPreimage(
      payerEntry,
      expirationLedger,
      ctx.networkPassphrase,
    );
    const digest = hash(preimage.toXDR());
    signatureValid =
      sig.publicKey === from && Keypair.fromPublicKey(from).verify(digest, sig.signature);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return fail("invalid_exact_stellar_payload_bad_signature", from);

  const nonce = creds.nonce.toString();
  if (ctx.nonceStore.isConsumed(requirements.network, from, nonce)) {
    return fail("invalid_exact_stellar_payload_nonce_reused", from);
  }

  return {
    ok: true,
    payer: from,
    nonce,
    expirationLedger,
    transaction,
    invokeOp,
    authEntry: payerEntry,
  };
}
