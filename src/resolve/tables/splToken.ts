/**
 * SPL Token error codes — namespace `spl-token`.
 *
 * Satisfies Requirement 6.3 for the SPL Token half.
 *
 * **Provenance.** Transcribed from the `TokenError` enum in
 * `interface/src/error.rs` of solana-program/token. `name` is the Rust variant
 * name and `message` is the `#[error(...)]` string verbatim. Upstream also
 * carries a `ToStr` impl whose text differs from `#[error]` on several variants
 * — "Error: insufficient funds" versus "Insufficient funds", for instance. The
 * `#[error]` string is used here because it is the canonical `Display` form of
 * the error type; the `ToStr` variants are CLI presentation strings, already
 * prefixed with "Error: " and therefore wrong to embed in a structured field.
 *
 * The numbering comes from upstream's explicit `TryFrom<u32>` arms, 0 through
 * 19, not from declaration order.
 *
 * Two messages read as upstream typos and are kept anyway, because a table that
 * silently improves on the source is a table a reader cannot check: 5 is "Fixed
 * supply" and 18 is "The provided decimals value different from the Mint
 * decimals".
 *
 * **Membership only.** Code 1 is `InsufficientFunds` here and
 * `ResultWithNegativeLamports` in the System Program table — same number,
 * unrelated meanings. Requirement 6.3's ban on range tests is what keeps those
 * apart, and Requirement 6.8's program ID selection is what makes the right
 * table get consulted.
 *
 * This table is the SPL Token program's enum. Token-2022 extends it with
 * additional codes and is a separate program at a separate address; it has no
 * namespace in this version and must not be resolved against this table.
 */

import { createErrorTable, type ErrorCodeMap, type ErrorTable } from './errorTable.js';

const CODES: ErrorCodeMap = {
  0: { name: 'NotRentExempt', message: 'Lamport balance below rent-exempt threshold' },
  1: { name: 'InsufficientFunds', message: 'Insufficient funds' },
  2: { name: 'InvalidMint', message: 'Invalid Mint' },
  3: { name: 'MintMismatch', message: 'Account not associated with this Mint' },
  4: { name: 'OwnerMismatch', message: 'Owner does not match' },
  5: { name: 'FixedSupply', message: 'Fixed supply' },
  6: { name: 'AlreadyInUse', message: 'Already in use' },
  7: {
    name: 'InvalidNumberOfProvidedSigners',
    message: 'Invalid number of provided signers',
  },
  8: {
    name: 'InvalidNumberOfRequiredSigners',
    message: 'Invalid number of required signers',
  },
  9: { name: 'UninitializedState', message: 'State is uninitialized' },
  10: {
    name: 'NativeNotSupported',
    message: 'Instruction does not support native tokens',
  },
  11: {
    name: 'NonNativeHasBalance',
    message: 'Non-native account can only be closed if its balance is zero',
  },
  12: { name: 'InvalidInstruction', message: 'Invalid instruction' },
  13: { name: 'InvalidState', message: 'State is invalid for requested operation' },
  14: { name: 'Overflow', message: 'Operation overflowed' },
  15: {
    name: 'AuthorityTypeNotSupported',
    message: 'Account does not support specified authority type',
  },
  16: { name: 'MintCannotFreeze', message: 'This token mint cannot freeze accounts' },
  17: { name: 'AccountFrozen', message: 'Account is frozen' },
  18: {
    name: 'MintDecimalsMismatch',
    message: 'The provided decimals value different from the Mint decimals',
  },
  19: {
    name: 'NonNativeNotSupported',
    message: 'Instruction does not support non-native tokens',
  },
};

/** Row data, exported for enumeration by tests. Frozen; see `createErrorTable`. */
export const SPL_TOKEN_ERROR_CODES: ErrorCodeMap = CODES;

/** The `spl-token` table. Requirement 6.3. */
export const splTokenErrorTable: ErrorTable = createErrorTable('spl-token', CODES);
