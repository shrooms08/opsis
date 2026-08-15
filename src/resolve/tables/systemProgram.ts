/**
 * System Program error codes — namespace `system-program`.
 *
 * Satisfies Requirement 6.3 for the System Program half.
 *
 * **Provenance.** Transcribed from the `SystemError` enum in
 * `system-interface/src/error.rs` of anza-xyz/solana-sdk. `name` is the Rust
 * variant name. `message` is the `ToStr` string, which is the text the enum
 * renders for display — the variants carry no separate `#[error]` attribute in
 * the current source, and the `ToStr` arm is the one authoritative message.
 * Upstream writes these lowercase and unpunctuated; they are kept verbatim
 * rather than tidied, so that a reader comparing Opsis output against a Solana
 * error string sees the same words.
 *
 * The numbering is not inferred from declaration order — upstream's explicit
 * `TryFrom<u32>` arms map 0 through 8 one by one, and those are the values used
 * here.
 *
 * **The codes start at 0 and this table is looked up by membership only.** Code
 * 1 is `ResultWithNegativeLamports` here, `InsufficientFunds` in the SPL Token
 * table, and *absent* from the SPL ATA table. Three different answers for the
 * same number, which is exactly why Requirement 6.3 forbids a numeric range
 * test and Requirement 6.8 makes the failing instruction's program ID select the
 * table. Nothing in this file compares a code against anything.
 */

import { createErrorTable, type ErrorCodeMap, type ErrorTable } from './errorTable.js';

const CODES: ErrorCodeMap = {
  0: {
    name: 'AccountAlreadyInUse',
    message: 'an account with the same address already exists',
  },
  1: {
    name: 'ResultWithNegativeLamports',
    message: 'account does not have enough SOL to perform the operation',
  },
  2: { name: 'InvalidProgramId', message: 'cannot assign account to this program id' },
  3: {
    name: 'InvalidAccountDataLength',
    message: 'cannot allocate account data of this length',
  },
  4: { name: 'MaxSeedLengthExceeded', message: 'length of requested seed is too long' },
  5: {
    name: 'AddressWithSeedMismatch',
    message: 'provided address does not match addressed derived from seed',
  },
  6: {
    name: 'NonceNoRecentBlockhashes',
    message: 'advancing stored nonce requires a populated RecentBlockhashes sysvar',
  },
  7: {
    name: 'NonceBlockhashNotExpired',
    message: 'stored nonce is still in recent_blockhashes',
  },
  8: {
    name: 'NonceUnexpectedBlockhashValue',
    message: 'specified nonce does not match stored nonce',
  },
};

/** Row data, exported for enumeration by tests. Frozen; see `createErrorTable`. */
export const SYSTEM_PROGRAM_ERROR_CODES: ErrorCodeMap = CODES;

/** The `system-program` table. Requirement 6.3. */
export const systemProgramErrorTable: ErrorTable = createErrorTable('system-program', CODES);
