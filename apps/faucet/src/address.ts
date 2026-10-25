import { StrKey } from "@stellar/stellar-sdk/base";
import { MSG } from "./messages.js";

export type AddressCheck =
  | { ok: true; address: string }
  | { ok: false; code: "address_missing" | "address_invalid" | "address_muxed" | "address_contract" | "address_is_secret"; message: string };

/**
 * Accepts only a plain ed25519 account address (G...). Runs entirely offline,
 * so a bad address never causes a Horizon or Friendbot call (S4).
 */
export function checkAddress(input: unknown): AddressCheck {
  if (typeof input !== "string") return { ok: false, code: "address_missing", message: MSG.addressMissing };
  const address = input.trim();
  if (address.length === 0) return { ok: false, code: "address_missing", message: MSG.addressMissing };
  if (address.length > 128) return { ok: false, code: "address_invalid", message: MSG.addressInvalid };
  if (StrKey.isValidEd25519PublicKey(address)) return { ok: true, address };
  if (StrKey.isValidMed25519PublicKey(address)) return { ok: false, code: "address_muxed", message: MSG.addressMuxed };
  if (StrKey.isValidContract(address)) return { ok: false, code: "address_contract", message: MSG.addressContract };
  if (StrKey.isValidEd25519SecretSeed(address)) return { ok: false, code: "address_is_secret", message: MSG.addressIsSecret };
  return { ok: false, code: "address_invalid", message: MSG.addressInvalid };
}
