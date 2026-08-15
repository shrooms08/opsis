/**
 * The `ErrorTable` contract and the one factory that builds a table.
 *
 * Supports Requirements 6.2 and 6.3. The tables themselves live one file per
 * namespace beside this one; `resolve/errorResolver.ts` consumes them.
 *
 * **Why this file exists.** design.md declares `ErrorTable` in the
 * `resolve/errorResolver.ts` section, but the four tables are written before the
 * resolver is and they all need the interface. Declaring it here keeps them
 * compilable on their own, and gives the freezing and the lookup exactly one
 * implementation instead of four copies. When `errorResolver.ts` is written it
 * MUST import (and may re-export) `ErrorTable` from here rather than declaring a
 * second copy — two structurally identical declarations would drift. This
 * follows the same convention `config.ts` uses for `CliOptions`.
 *
 * **Lookup is membership, never range.** This is the whole point of
 * Requirement 6.3, and it is enforced structurally: the only operation this
 * module offers is a single indexed read of a fixed record. There is no
 * comparison, no arithmetic, and no band constant anywhere in `tables/`. The
 * reason it matters is that System Program, SPL Token, and SPL ATA all number
 * their errors from 0, so code 1 is a defined value in more than one of them
 * with entirely different meanings. A numeric test cannot tell them apart; only
 * membership in the specific failing program's table can, and Requirement 6.8
 * makes the failing instruction's program ID the thing that picks the table.
 *
 * **Absence is a real answer.** `lookup` returns `undefined` for a code the
 * table does not hold, and the caller turns that into the `unresolved` variant
 * with reason `not-in-table` (Req 6.10). Nothing here invents a message for an
 * unknown code, and nothing here throws or writes to a stream.
 */

import type { ErrorNamespace } from '../../model/analysis.js';

/** One table row: the enum variant's name and its declared message. */
export interface ErrorEntry {
  readonly name: string;
  readonly message: string;
}

/**
 * A frozen code-to-meaning map for one error namespace.
 *
 * The member list is exactly what design.md specifies. Nothing else belongs on
 * it — in particular not a program ID, because mapping a program ID to a table
 * is the resolver's job (Req 6.8), and not a code list, because a table that
 * could enumerate itself would invite a range scan.
 */
export interface ErrorTable {
  readonly namespace: ErrorNamespace;
  lookup(code: number): ErrorEntry | undefined;
}

/** Shape each table file declares its rows in. Keys are the numeric codes. */
export type ErrorCodeMap = Readonly<Record<number, ErrorEntry>>;

/**
 * Build a frozen table from a code map.
 *
 * Freezing is deep as far as it needs to be — the returned table, the internal
 * record, and every entry object — so a consumer that reaches a row cannot
 * mutate shared data for every later caller. The tables are module-level
 * singletons, so an unfrozen row would be a process-wide hazard rather than a
 * local one.
 *
 * The internal record has a null prototype. That is not decoration: with an
 * ordinary object literal, a lookup would fall through to `Object.prototype`
 * for a handful of keys, and while no error code stringifies to `constructor`
 * today, "the read only ever sees rows this table declared" is worth having as
 * a property of the code rather than as an argument about numeric formatting.
 */
export function createErrorTable(
  namespace: ErrorNamespace,
  codes: ErrorCodeMap,
): ErrorTable {
  const rows: Record<number, ErrorEntry> = Object.create(null) as Record<number, ErrorEntry>;
  for (const [code, entry] of Object.entries(codes)) {
    rows[Number(code)] = Object.freeze(entry);
  }
  Object.freeze(rows);

  return Object.freeze({
    namespace,
    // A plain indexed read. `noUncheckedIndexedAccess` is what makes the
    // `undefined` for an absent code part of the type rather than a surprise.
    lookup: (code: number): ErrorEntry | undefined => rows[code],
  });
}
