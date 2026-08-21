/**
 * Program display names — the human label beside a program ID, and nothing else.
 *
 * **This module is display labelling only, and that is a correctness
 * constraint rather than a stylistic note.** `InstructionNode.programName` must
 * never participate in:
 *
 * - **decoder selection.** `registry.ts` picks decoders by program ID through
 *   `rungsFor`, and it does not import this module. A program with no display
 *   name decodes exactly as well as one with a name.
 * - **error namespace selection.** `resolve/errorResolver.ts` selects a table by
 *   `failingProgramId` and by attestation, and it does not import this module.
 * - **confidence.** Nothing folds the presence or absence of a name into any
 *   `Confidence` marker. A node whose program is absent from the table below is
 *   not less well understood — the name is cosmetic, and a missing one is a
 *   missing *label*, not missing information about the instruction.
 *
 * The constraint is held up by shape rather than by this comment alone.
 * `programNameFor` is a pure `Base58Address → string | null`: it takes no
 * decode, no accounts, no response, and no confidence, so there is nothing for
 * it to influence and nothing it could consult. In the other direction, it has
 * exactly one caller in `src/` — `createNode` in `instructionTree.ts`, the one
 * place that sets the field — and `tests/decode/programNames.test.ts` asserts
 * that caller count against the source tree, so a second consumer appearing in
 * the decode or resolve path fails a test rather than passing review.
 *
 * That the field is set in the tree builder, *before* the registry runs, is safe
 * for the same reason: the value is inert. Nothing downstream branches on it —
 * `pipeline.ts` rewrites `decode` and `accounts` per node and carries
 * `programName` through untouched, and `analyze/assemble.ts` propagates
 * confidence from the decode markers.
 *
 * **Addresses.** System Program, SPL Token, and SPL Associated Token Account are
 * imported from their built-in decoder modules rather than re-spelled, so this
 * table and the decoder registration cannot drift apart — the same discipline
 * `registry.ts` and `resolve/errorResolver.ts` already apply. The remaining three
 * programs are new to the codebase and have nowhere to import from, so they are
 * literals here; `tests/decode/programNames.test.ts` asserts every one of the six
 * base58-decodes to exactly 32 bytes, because a transposed character that stays
 * inside the base58 alphabet produces an entry that silently never matches and a
 * program that silently never gets a name.
 *
 * **Memo v1 is deliberately absent.** The legacy memo program lives at
 * `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo`, a different 32-byte address
 * from the v3 program below, and it is a distinct deployed program rather than an
 * alias. It is left out because the table is specified as exactly these six
 * names, and because labelling it would mean choosing a display string — `Memo`
 * would make two different programs indistinguishable in the output, and
 * `Memo (v1)` would be a name nobody asked for. The cost of the omission is
 * bounded and is the documented default: a v1 memo instruction gets
 * `programName: null` and is otherwise analyzed identically. Adding it later is
 * one entry.
 */

import type { Base58Address } from '../model/analysis.js';
import { SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID } from './builtin/splAssociatedTokenAccount.js';
import { SPL_TOKEN_PROGRAM_ID } from './builtin/splToken.js';
import { SYSTEM_PROGRAM_ID } from './builtin/systemProgram.js';

/**
 * Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).
 *
 * A separate deployment from SPL Token with its own address, not a version of
 * it, so it gets its own entry and its own name. No built-in decoder covers it
 * in v1, which is exactly the case this module has to be safe for: the node
 * carries the name and the `Unknown` decode side by side, and the name makes no
 * claim about the payload.
 */
const TOKEN_2022_PROGRAM_ID: Base58Address = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Compute Budget (`ComputeBudget111111111111111111111111111111`). */
const COMPUTE_BUDGET_PROGRAM_ID: Base58Address = 'ComputeBudget111111111111111111111111111111';

/**
 * Memo (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) — the current program.
 * See the module header for why the legacy v1 address is not listed.
 */
const MEMO_PROGRAM_ID: Base58Address = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * Program ID to display name.
 *
 * Exported as a `ReadonlyMap`, which is what actually prevents a caller
 * extending the table: `set` is absent from the type, so an injected name is a
 * compile error rather than a runtime surprise. `Object.freeze` is applied as
 * well and is worth exactly what it is worth here — it blocks property
 * assignment on the object and does *not* block `Map.prototype.set`, so it is
 * belt to the type's braces and not the guarantee itself.
 *
 * A `Map` rather than a plain record on purpose. Record keys inherit from
 * `Object.prototype`, and the base58 alphabet contains every letter of
 * `constructor`, `toString`, and `valueOf` — so a record lookup could hand back
 * a function for a program ID that is not in the table. `Map` has no prototype
 * chain to fall through.
 */
export const PROGRAM_NAMES: ReadonlyMap<Base58Address, string> = Object.freeze(
  new Map<Base58Address, string>([
    [SYSTEM_PROGRAM_ID, 'System Program'],
    [SPL_TOKEN_PROGRAM_ID, 'SPL Token'],
    [TOKEN_2022_PROGRAM_ID, 'Token-2022'],
    [SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID, 'SPL Associated Token Account'],
    [COMPUTE_BUDGET_PROGRAM_ID, 'Compute Budget'],
    [MEMO_PROGRAM_ID, 'Memo'],
  ]),
);

/**
 * The display name for a program, or `null` when the table does not list it.
 *
 * `null` is the ordinary answer for the overwhelming majority of mainnet
 * programs and carries no negative meaning: the instruction is decoded, its
 * error resolved, and its confidence computed identically either way.
 *
 * The `null`-accepting parameter mirrors `InstructionNode.programId`, which is
 * `null` when the program index could not be resolved (Req 3.7). An unresolved
 * program has no address to look up, so it has no name — stated here once rather
 * than as a guard at the call site.
 */
export function programNameFor(programId: Base58Address | null): string | null {
  if (programId === null) return null;
  return PROGRAM_NAMES.get(programId) ?? null;
}
