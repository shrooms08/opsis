/**
 * SPL Associated Token Account error codes — namespace
 * `spl-associated-token-account`.
 *
 * Satisfies Requirement 6.3 for the SPL ATA half.
 *
 * **Provenance.** Transcribed from the `AssociatedTokenAccountError` enum in
 * `interface/src/error.rs` of solana-program/associated-token-account. `name` is
 * the Rust variant name and `message` is the `Display` string verbatim.
 *
 * **This table has exactly one row, and that is not an omission.** Upstream
 * declares a single variant, `InvalidOwner`, at code 0. The enum was checked at
 * `main` and at the `program@v6.0.0` and `program@v1.1.2` tags, and it is one
 * variant in all three — the ATA program reports almost everything else by
 * returning a built-in `ProgramError` (`InvalidSeeds`, `IllegalOwner`, and so
 * on), which is not a `Custom` code and never reaches this table. A one-row
 * table is the honest transcription.
 *
 * **Consequence for `Custom 1` raised by the ATA program.** Code 1 is *absent*
 * here. `lookup(1)` returns `undefined`, and Requirement 6.10 turns that into
 * the `unresolved` variant with reason `not-in-table`, numeric code preserved,
 * no message. That is the correct outcome for `tests/golden/03-program-table-
 * error`, whose `meta.err` is `{InstructionError: [3, {Custom: 1}]}` at a
 * top-level instruction whose program is the ATA program.
 *
 * The temptation to do otherwise is worth naming, because that fixture's log
 * array makes the wrong answer look right. The logs show the ATA program
 * invoking the System Program at depth 2, `Transfer: insufficient lamports
 * 1588537, need 2039280`, and `Program 11111111111111111111111111111111 failed:
 * custom program error: 0x1`. So the `Custom 1` really did originate in the
 * System Program, where 1 means `ResultWithNegativeLamports` — and the ATA
 * program propagated it upward unchanged. But `meta.err` carries a **top-level**
 * index only (Req 5.1), so the failing instruction's program is the ATA program,
 * and Requirement 6.8 says that program ID selects the namespace. Reaching into
 * the System Program's table because the number happens to exist there is the
 * range-matching mistake Requirement 6.3 forbids, dressed up as a CPI
 * inference. Attributing a propagated code to the program it came from requires
 * log-based CPI attribution, which is Phase 2 (Req 5.5) and is why
 * `cpiAttribution` is unconditionally `null` in v1.
 *
 * The verbatim log array is captured in full under Requirement 21.1, so a reader
 * of the `03` output still sees `Transfer: insufficient lamports 1588537, need
 * 2039280` sitting beside the unresolved code. The true answer is on screen; it
 * is just not something this table is entitled to claim.
 *
 * If a future ATA release adds variants, they are added here as rows. Nothing
 * about the lookup changes, because it is membership, never range (Req 6.3).
 */

import { createErrorTable, type ErrorCodeMap, type ErrorTable } from './errorTable.js';

const CODES: ErrorCodeMap = {
  0: {
    name: 'InvalidOwner',
    message: 'Associated token account owner does not match address derivation',
  },
};

/** Row data, exported for enumeration by tests. Frozen; see `createErrorTable`. */
export const SPL_ASSOCIATED_TOKEN_ACCOUNT_ERROR_CODES: ErrorCodeMap = CODES;

/** The `spl-associated-token-account` table. Requirement 6.3. */
export const splAssociatedTokenAccountErrorTable: ErrorTable = createErrorTable(
  'spl-associated-token-account',
  CODES,
);
