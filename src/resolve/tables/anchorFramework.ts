/**
 * Anchor framework error codes — namespace `anchor-framework`.
 *
 * Satisfies Requirement 6.2 for the table half; the attestation gate that
 * licenses a lookup here is Requirement 6.2's *other* condition and lives in
 * `resolve/errorResolver.ts`.
 *
 * **Provenance.** Every row is transcribed from the `ErrorCode` enum in
 * `lang/error/src/lib.rs` of coral-xyz/anchor. `name` is the Rust variant name,
 * which is what Anchor's `#[error_code]` macro emits as `Error Code:` in an
 * `AnchorError` log line. `message` is the `#[msg(...)]` string verbatim, which
 * is what the same macro emits as `Error Message:`. Nothing here is
 * reconstructed from a doc comment or from a secondary source — Requirement 6
 * exists to stop the tool from stating things it does not know, and a table of
 * plausible-sounding messages would defeat it more thoroughly than an empty
 * table would.
 *
 * Where the Rust doc comment and the `#[msg]` string disagree, the `#[msg]`
 * string wins, because that is the text the program actually emits. Three rows
 * are affected and they read oddly on purpose: 2029's message says "group
 * address" though the variant is `...MemberAddress`, 2033's says "A close
 * authority constraint" without "extension", and 2036's says "delegate" where
 * the doc comment says "authority". Those are upstream's words, not a
 * transcription slip.
 *
 * **Band structure, and why the table does not encode it.** Anchor documents its
 * codes as `>= 100` instruction, `>= 1000` IDL, `1500` event, `>= 2000`
 * constraint, `2500` require, `>= 3000` account, `>= 4100` misc, `= 5000`
 * deprecated. The comments below group the rows that way for a reader, and that
 * is the only place the bands appear: lookup is membership only (Req 6.3). The
 * design's 2000–5999 gate is a fact about the resolver, not about this file, so
 * `errorResolver.ts` owns it.
 *
 * That gate is also why the sub-2000 rows are currently unreachable through
 * `resolveError` — a code of 100 does not enter the 2000–5999 branch. They are
 * included anyway because they are genuinely part of the framework enum, and
 * because a membership-based table stays correct if that gate is ever widened,
 * whereas a table missing them would answer `undefined` for a code it should
 * know.
 *
 * **Version.** Transcribed from anchor `master` at the time of writing, which
 * carries codes up to 2044. Codes 2040–2044 are recent additions absent from
 * the published `@coral-xyz/anchor-errors` mirror; every other row is present in
 * both and cross-checked against it. A program built against an older Anchor
 * simply never raises 2040–2044, so holding them costs nothing: the table is a
 * superset of what any single deployed version can emit, and membership is only
 * ever consulted for a code a program actually raised.
 *
 * Codes at or above 6000 are user-defined (`ERROR_CODE_OFFSET`) and belong to
 * the `anchor-user` namespace, resolved against the program's IDL. They are not
 * in this table and must not be added to it.
 */

import { createErrorTable, type ErrorCodeMap, type ErrorTable } from './errorTable.js';

const CODES: ErrorCodeMap = {
  // Instructions.
  100: { name: 'InstructionMissing', message: 'Instruction discriminator not provided' },
  101: { name: 'InstructionFallbackNotFound', message: 'Fallback functions are not supported' },
  102: {
    name: 'InstructionDidNotDeserialize',
    message: 'The program could not deserialize the given instruction',
  },
  103: {
    name: 'InstructionDidNotSerialize',
    message: 'The program could not serialize the given instruction',
  },

  // IDL instructions.
  1000: {
    name: 'IdlInstructionStub',
    message: 'The program was compiled without idl instructions',
  },
  1001: {
    name: 'IdlInstructionInvalidProgram',
    message: 'Invalid program given to the IDL instruction',
  },
  1002: {
    name: 'IdlAccountNotEmpty',
    message: 'IDL account must be empty in order to resize, try closing first',
  },

  // Event instructions.
  1500: {
    name: 'EventInstructionStub',
    message: 'The program was compiled without `event-cpi` feature',
  },

  // Constraints.
  2000: { name: 'ConstraintMut', message: 'A mut constraint was violated' },
  2001: { name: 'ConstraintHasOne', message: 'A has one constraint was violated' },
  2002: { name: 'ConstraintSigner', message: 'A signer constraint was violated' },
  2003: { name: 'ConstraintRaw', message: 'A raw constraint was violated' },
  2004: { name: 'ConstraintOwner', message: 'An owner constraint was violated' },
  2005: { name: 'ConstraintRentExempt', message: 'A rent exemption constraint was violated' },
  2006: { name: 'ConstraintSeeds', message: 'A seeds constraint was violated' },
  2007: { name: 'ConstraintExecutable', message: 'An executable constraint was violated' },
  2008: {
    name: 'ConstraintState',
    message: 'Deprecated Error, feel free to replace with something else',
  },
  2009: { name: 'ConstraintAssociated', message: 'An associated constraint was violated' },
  2010: {
    name: 'ConstraintAssociatedInit',
    message: 'An associated init constraint was violated',
  },
  2011: { name: 'ConstraintClose', message: 'A close constraint was violated' },
  2012: { name: 'ConstraintAddress', message: 'An address constraint was violated' },
  2013: { name: 'ConstraintZero', message: 'Expected zero account discriminant' },
  2014: { name: 'ConstraintTokenMint', message: 'A token mint constraint was violated' },
  2015: { name: 'ConstraintTokenOwner', message: 'A token owner constraint was violated' },
  2016: {
    name: 'ConstraintMintMintAuthority',
    message: 'A mint mint authority constraint was violated',
  },
  2017: {
    name: 'ConstraintMintFreezeAuthority',
    message: 'A mint freeze authority constraint was violated',
  },
  2018: { name: 'ConstraintMintDecimals', message: 'A mint decimals constraint was violated' },
  2019: { name: 'ConstraintSpace', message: 'A space constraint was violated' },
  2020: {
    name: 'ConstraintAccountIsNone',
    message: 'A required account for the constraint is None',
  },
  2021: {
    name: 'ConstraintTokenTokenProgram',
    message: 'A token account token program constraint was violated',
  },
  2022: {
    name: 'ConstraintMintTokenProgram',
    message: 'A mint token program constraint was violated',
  },
  2023: {
    name: 'ConstraintAssociatedTokenTokenProgram',
    message: 'An associated token account token program constraint was violated',
  },
  2024: {
    name: 'ConstraintMintGroupPointerExtension',
    message: 'A group pointer extension constraint was violated',
  },
  2025: {
    name: 'ConstraintMintGroupPointerExtensionAuthority',
    message: 'A group pointer extension authority constraint was violated',
  },
  2026: {
    name: 'ConstraintMintGroupPointerExtensionGroupAddress',
    message: 'A group pointer extension group address constraint was violated',
  },
  2027: {
    name: 'ConstraintMintGroupMemberPointerExtension',
    message: 'A group member pointer extension constraint was violated',
  },
  2028: {
    name: 'ConstraintMintGroupMemberPointerExtensionAuthority',
    message: 'A group member pointer extension authority constraint was violated',
  },
  // Upstream's `#[msg]` says "group address" while the variant says
  // "MemberAddress". Verbatim, per the provenance note above.
  2029: {
    name: 'ConstraintMintGroupMemberPointerExtensionMemberAddress',
    message: 'A group member pointer extension group address constraint was violated',
  },
  2030: {
    name: 'ConstraintMintMetadataPointerExtension',
    message: 'A metadata pointer extension constraint was violated',
  },
  2031: {
    name: 'ConstraintMintMetadataPointerExtensionAuthority',
    message: 'A metadata pointer extension authority constraint was violated',
  },
  2032: {
    name: 'ConstraintMintMetadataPointerExtensionMetadataAddress',
    message: 'A metadata pointer extension metadata address constraint was violated',
  },
  // Upstream's `#[msg]` omits "extension" here.
  2033: {
    name: 'ConstraintMintCloseAuthorityExtension',
    message: 'A close authority constraint was violated',
  },
  2034: {
    name: 'ConstraintMintCloseAuthorityExtensionAuthority',
    message: 'A close authority extension authority constraint was violated',
  },
  2035: {
    name: 'ConstraintMintPermanentDelegateExtension',
    message: 'A permanent delegate extension constraint was violated',
  },
  // Upstream's `#[msg]` says "delegate" where the doc comment says "authority".
  2036: {
    name: 'ConstraintMintPermanentDelegateExtensionDelegate',
    message: 'A permanent delegate extension delegate constraint was violated',
  },
  2037: {
    name: 'ConstraintMintTransferHookExtension',
    message: 'A transfer hook extension constraint was violated',
  },
  2038: {
    name: 'ConstraintMintTransferHookExtensionAuthority',
    message: 'A transfer hook extension authority constraint was violated',
  },
  2039: {
    name: 'ConstraintMintTransferHookExtensionProgramId',
    message: 'A transfer hook extension transfer hook program id constraint was violated',
  },
  2040: {
    name: 'ConstraintDuplicateMutableAccount',
    message: 'A duplicate mutable account constraint was violated',
  },

  // Migration.
  2041: { name: 'AccountAlreadyMigrated', message: 'Account is already migrated' },
  2042: { name: 'AccountNotMigrated', message: 'Account must be migrated before exiting' },

  // Constraints, continued — upstream numbers the pausable extension after the
  // migration errors rather than beside the other extension constraints.
  2043: {
    name: 'ConstraintMintPausableExtension',
    message: 'A pausable extension constraint was violated',
  },
  2044: {
    name: 'ConstraintMintPausableAuthority',
    message: 'A pausable extension authority constraint was violated',
  },

  // Require.
  2500: { name: 'RequireViolated', message: 'A require expression was violated' },
  2501: { name: 'RequireEqViolated', message: 'A require_eq expression was violated' },
  2502: { name: 'RequireKeysEqViolated', message: 'A require_keys_eq expression was violated' },
  2503: { name: 'RequireNeqViolated', message: 'A require_neq expression was violated' },
  2504: { name: 'RequireKeysNeqViolated', message: 'A require_keys_neq expression was violated' },
  2505: { name: 'RequireGtViolated', message: 'A require_gt expression was violated' },
  2506: { name: 'RequireGteViolated', message: 'A require_gte expression was violated' },

  // Accounts.
  3000: {
    name: 'AccountDiscriminatorAlreadySet',
    message: 'The account discriminator was already set on this account',
  },
  3001: {
    name: 'AccountDiscriminatorNotFound',
    message: 'No discriminator was found on the account',
  },
  3002: {
    name: 'AccountDiscriminatorMismatch',
    message: 'Account discriminator did not match what was expected',
  },
  3003: { name: 'AccountDidNotDeserialize', message: 'Failed to deserialize the account' },
  3004: { name: 'AccountDidNotSerialize', message: 'Failed to serialize the account' },
  3005: {
    name: 'AccountNotEnoughKeys',
    message: 'Not enough account keys given to the instruction',
  },
  3006: { name: 'AccountNotMutable', message: 'The given account is not mutable' },
  3007: {
    name: 'AccountOwnedByWrongProgram',
    message: 'The given account is owned by a different program than expected',
  },
  3008: { name: 'InvalidProgramId', message: 'Program ID was not as expected' },
  3009: { name: 'InvalidProgramExecutable', message: 'Program account is not executable' },
  3010: { name: 'AccountNotSigner', message: 'The given account did not sign' },
  3011: {
    name: 'AccountNotSystemOwned',
    message: 'The given account is not owned by the system program',
  },
  3012: {
    name: 'AccountNotInitialized',
    message: 'The program expected this account to be already initialized',
  },
  3013: {
    name: 'AccountNotProgramData',
    message: 'The given account is not a program data account',
  },
  3014: {
    name: 'AccountNotAssociatedTokenAccount',
    message: 'The given account is not the associated token account',
  },
  3015: {
    name: 'AccountSysvarMismatch',
    message: 'The given public key does not match the required sysvar',
  },
  3016: {
    name: 'AccountReallocExceedsLimit',
    message: 'The account reallocation exceeds the MAX_PERMITTED_DATA_INCREASE limit',
  },
  3017: {
    name: 'AccountDuplicateReallocs',
    message: 'The account was duplicated for more than one reallocation',
  },

  // Miscellaneous.
  4100: {
    name: 'DeclaredProgramIdMismatch',
    message: 'The declared program id does not match the actual program id',
  },
  4101: {
    name: 'TryingToInitPayerAsProgramAccount',
    message: 'You cannot/should not initialize the payer account as a program account',
  },
  4102: { name: 'InvalidNumericConversion', message: 'Error during numeric conversion' },

  // Deprecated. The only code in the 5000 band, and the one the
  // `04-unattested-band-collision` fixture's `Custom 5000` would hit if
  // attestation licensed the lookup — which it does not, which is the point of
  // that fixture.
  5000: {
    name: 'Deprecated',
    message: 'The API being used is deprecated and should no longer be used',
  },
};

/** Row data, exported for enumeration by tests. Frozen; see `createErrorTable`. */
export const ANCHOR_FRAMEWORK_ERROR_CODES: ErrorCodeMap = CODES;

/** The `anchor-framework` table. Requirement 6.2. */
export const anchorFrameworkErrorTable: ErrorTable = createErrorTable(
  'anchor-framework',
  CODES,
);
