/**
 * Transaction signature validation. Requirements 1.1, 1.2, 1.3.
 *
 * Validation is a base58 decode followed by a byte-length check of exactly 64.
 * It is never a character count: base58 length varies with the number of
 * leading zero bytes, so a character-count check both rejects valid signatures
 * (64 bytes with leading zeroes encode to fewer than 88 characters) and accepts
 * invalid ones (an 88-character string can decode to 65 bytes).
 *
 * This module returns a typed result and never throws, never writes to a
 * stream, and never exits. Turning a `SignatureError` into a stderr message and
 * exit code 2 belongs to `cli.ts` and `exit.ts`.
 */

import bs58 from 'bs58';

import type { Base58Signature } from './model/analysis.js';

/** The number of bytes a Solana transaction signature decodes to. */
const SIGNATURE_BYTE_LENGTH = 64;

/**
 * Why an input is not a usable signature. The two variants map one-to-one onto
 * the two failure criteria: `not-base58` is Requirement 1.2, `wrong-length` is
 * Requirement 1.3, which carries the true decoded byte length so the diagnostic
 * can report what was actually supplied.
 */
export type SignatureError =
  | { readonly kind: 'not-base58'; readonly message: string }
  | { readonly kind: 'wrong-length'; readonly byteLength: number };

/**
 * Validate a candidate transaction signature.
 *
 * On success the input string is returned verbatim as the `Base58Signature`;
 * nothing is re-encoded, so the value that reaches the source layer is the one
 * the user typed.
 */
export function validateSignature(
  input: string,
): { ok: true; signature: Base58Signature } | { ok: false; error: SignatureError } {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(input);
  } catch (cause) {
    return {
      ok: false,
      error: {
        kind: 'not-base58',
        message: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }

  if (decoded.length !== SIGNATURE_BYTE_LENGTH) {
    return { ok: false, error: { kind: 'wrong-length', byteLength: decoded.length } };
  }

  return { ok: true, signature: input };
}
