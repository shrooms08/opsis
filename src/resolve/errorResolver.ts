/**
 * Error code resolution — which namespace governs a code, and what it means.
 *
 * Satisfies Requirement 6 (6.1–6.17).
 *
 * This module answers "what does this error code mean" and refuses to answer it
 * from the number alone. Two rules carry the whole file, and everything else is
 * bookkeeping around them:
 *
 * 1. **A table is selected by the failing instruction's program ID, and a code is
 *    found in it by membership** (Req 6.3, 6.8). System Program, SPL Token, and
 *    SPL ATA all number their errors from 0, so `Custom 1` is a defined row in
 *    more than one of them with unrelated meanings. A numeric range test cannot
 *    tell them apart and would attribute the error to the wrong program.
 * 2. **Anchor resolution requires attestation** (Req 6.2, 6.11, 6.15–6.17).
 *    Membership of a code in 2000–5999, or at 6000 and above, is a fact about the
 *    *number*, not evidence about the *program*. Any program may number its own
 *    enum into those bands. Without evidence that the raising program is Anchor,
 *    no Anchor table is consulted and the code is reported unresolved with reason
 *    `unattested-namespace` at `raw` confidence.
 *
 * `tests/golden/04-unattested-band-collision` is why rule 2 exists in recorded
 * data rather than in the abstract: `Prism8hsRo6Ww5jiN5Zeh3YDPLZHqHduCPSAV7JF7qv`
 * fails with `Custom 5000`, its log array contains no `AnchorError` line at all,
 * and what it does contain is `Program log: No profitable buy/sell pair was
 * found.` Anchor happens to define `Deprecated` at 5000. Printing that would put
 * a confident wrong answer on screen directly above the true one, which is worse
 * than printing the bare code — the reason the unattested outcome is `raw` and
 * not a hedged `partial`.
 *
 * ## What counts as attestation
 *
 * Three values, and they are not interchangeable (Req 6.12):
 *
 * - `'anchor-error-log'` — an `AnchorError` line in the verbatim log array whose
 *   `Error Number` equals the code being resolved. The strongest evidence there
 *   is: the program named the error during *this* execution, and the line also
 *   carries the name and the message, so no table is needed to produce them
 *   (Req 6.13, 6.15). The match is on the number; the mere presence of the word
 *   `AnchorError` somewhere in the logs attests nothing, because a transaction
 *   routinely runs several programs and the line may belong to another one.
 * - `'idl'` — an IDL is loaded for the failing program ID (Req 6.16). Direct
 *   evidence, and for codes at or above 6000 it also supplies the `errors` array.
 *   Weaker than a log line only in that an IDL is a static artifact which may be
 *   stale or describe another deployed version.
 * - `'program-id'` — the failing program is one of the three known built-ins
 *   whose table is selected by address equality (Req 6.14). No inference is
 *   involved, which is exactly why those three are not subject to rule 2: "is
 *   this the SPL Token program" is a fact about an address, while "is this an
 *   Anchor program" has no address to check.
 *
 * ## Two deviations from design.md, both forced by types the design predates
 *
 * 1. **`ResolvedError.message` is `string | null`.** design.md declares `string`.
 *    An IDL `errors` entry may carry `msg: null` (see `IdlErrorCode`), and such a
 *    code resolves to a *named* error with no message: the name is real evidence
 *    from the artifact, and the message genuinely is not there. Substituting the
 *    name, or an empty string, would manufacture text the IDL does not contain.
 *    The widening is recorded on the field in `model/analysis.ts`.
 * 2. **`idls` accepts `null`.** design.md types it `IdlStore`. `pipeline.ts`
 *    still carries the IDL seam as `idls?: null` because the store is threaded by
 *    a later task, and "no store was loaded" is the same fact as "no IDL for this
 *    program" at every point this module reads it. Accepting `null` lets the
 *    pipeline wire this module now instead of waiting on that seam, without any
 *    caller inventing an empty store.
 *
 * Pure and total: reads only its arguments, mutates nothing, throws on no input,
 * and writes to no stream. Every input produces a `ResolvedError`, including
 * inputs that are not shaped the way the RPC promises — the payload arrives from
 * `JSON.parse` and is untrusted, per the contract in `model/rawResponse.ts`.
 */

import { SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID } from '../decode/builtin/splAssociatedTokenAccount.js';
import { SPL_TOKEN_PROGRAM_ID } from '../decode/builtin/splToken.js';
import { SYSTEM_PROGRAM_ID } from '../decode/builtin/systemProgram.js';
import type { IdlStore, LoadedIdl } from '../decode/idl/idlStore.js';
import type {
  Base58Address,
  ErrorAttestation,
  ErrorNamespace,
  FailureReport,
  LogReport,
  ResolvedError,
  UnresolvedErrorReason,
} from '../model/analysis.js';
import type { RawTransactionError } from '../model/rawResponse.js';
import type { FailureLocation } from './failure.js';
import { anchorFrameworkErrorTable } from './tables/anchorFramework.js';
import { splAssociatedTokenAccountErrorTable } from './tables/splAssociatedTokenAccount.js';
import { splTokenErrorTable } from './tables/splToken.js';
import { systemProgramErrorTable } from './tables/systemProgram.js';
import type { ErrorEntry, ErrorTable } from './tables/errorTable.js';

/**
 * Re-exported, not redeclared. design.md places `ErrorTable` in this module's
 * block, but the four tables were written first and all need it, so it is
 * declared in `tables/errorTable.ts` — see the note at the top of that file. Two
 * structurally identical declarations would drift.
 */
export type { ErrorEntry, ErrorTable } from './tables/errorTable.js';

// ---------------------------------------------------------------------------
// Bands and tables
// ---------------------------------------------------------------------------

/** Anchor's `ERROR_CODE_OFFSET`: user-defined codes start here (Req 6.1). */
const USER_CODE_MIN = 6000;

/** The framework band, inclusive on both ends (Req 6.2). */
const FRAMEWORK_CODE_MIN = 2000;
const FRAMEWORK_CODE_MAX = 5999;

/**
 * The three programs whose table is chosen by address equality (Req 6.3, 6.14).
 *
 * A map from program ID to table, and deliberately *only* that: the tables
 * themselves hold no program ID, because mapping an address to a namespace is
 * this module's job. The program IDs are imported from their built-in decoders
 * rather than re-spelled here, so a decoder and the error table it pairs with can
 * never disagree about which address they are about.
 */
const PROGRAM_TABLES: ReadonlyMap<Base58Address, ErrorTable> = new Map([
  [SYSTEM_PROGRAM_ID, systemProgramErrorTable],
  [SPL_TOKEN_PROGRAM_ID, splTokenErrorTable],
  [SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID, splAssociatedTokenAccountErrorTable],
]);

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Resolve `meta.err` into a `ResolvedError`.
 *
 * `err` is the whole error payload rather than just the detail element, because
 * the non-`InstructionError` variants (`"AlreadyProcessed"`,
 * `{ DuplicateInstruction: 3 }`) are error payloads this function still has to
 * report, and they have no detail element to be handed.
 *
 * Resolution order, which is design.md's:
 *
 * 1. Not a `Custom` payload → the `non-custom` variant, variant name verbatim.
 * 2. `Custom` code unparseable as an integer → `unresolved`, `code: null`,
 *    reason `unparseable-code` (Req 6.9).
 * 3. Code ≥ 6000 **and attested** → the failing program's IDL `errors` array
 *    (Req 6.1), or `no-idl` when attestation came from a log line that named no
 *    message and no IDL is loaded (Req 6.5), or `not-in-table` when the IDL is
 *    loaded but does not declare the code (Req 6.10).
 * 4. Code in 2000–5999 **and attested** → the log line's own name and message,
 *    else the Anchor framework table (Req 6.2), else `not-in-table` (Req 6.10).
 * 5. Otherwise, the failing program's own table when it is one of the three
 *    built-ins, by membership (Req 6.3) — `not-in-table` when the table does not
 *    hold the code (Req 6.10).
 * 6. Nothing governs it: `unattested-namespace` when the code sits in an Anchor
 *    band and nothing attested (Req 6.11), `not-in-table` otherwise (Req 6.6).
 *
 * Steps 3 and 4 precede step 5 because that is the order design.md sets, and the
 * bands cannot collide with the built-in tables in practice: those three programs
 * number their errors below 100, so no code they define reaches 2000.
 */
export function resolveError(
  err: RawTransactionError,
  failingProgramId: Base58Address | null,
  idls: IdlStore | null,
  logs: LogReport,
): ResolvedError {
  const payload = readErrorPayload(err);

  if (payload.kind === 'non-custom') {
    return {
      kind: 'non-custom',
      variant: payload.variant,
      detail: payload.detail,
      confidence: 'full',
    };
  }

  const rawCode = spell(payload.value);
  const code = parseCode(payload.value);
  if (code === null) {
    return unresolved(null, rawCode, 'unparseable-code', failingProgramId);
  }

  // Both attestation forms are computed up front: the outcome depends on which
  // one is present at three separate points below, and recomputing the log scan
  // per branch would invite the two branches to disagree about it.
  const logLine = findAnchorErrorLine(logs.messages, code);
  const idl = failingProgramId === null ? undefined : (idls?.get(failingProgramId) ?? undefined);
  const attestation: ErrorAttestation | null =
    logLine !== null ? 'anchor-error-log' : idl !== undefined ? 'idl' : null;

  if (code >= USER_CODE_MIN && attestation !== null) {
    return resolveUserCode(code, rawCode, failingProgramId, idl, logLine, attestation);
  }

  if (isFrameworkCode(code) && attestation !== null) {
    return resolveFrameworkCode(code, rawCode, failingProgramId, logLine, attestation);
  }

  // Unattested, or outside both bands. A known program's own table still governs
  // its codes, and it does so without attestation (Req 6.14) — which is also why
  // an unattested band code raised by one of the three lands here rather than in
  // `unattested-namespace`: Requirement 6.11 excludes those three by name.
  const table = failingProgramId === null ? undefined : PROGRAM_TABLES.get(failingProgramId);
  if (table !== undefined) {
    const entry = table.lookup(code);
    return entry === undefined
      ? unresolved(code, rawCode, 'not-in-table', failingProgramId)
      : resolved(code, table.namespace, entry.name, entry.message, 'program-id', failingProgramId);
  }

  // Nothing governs the code. The two reasons are genuinely different questions
  // and Requirements 6.6 and 6.11 keep them apart: "a framework's band covers
  // this number but nothing says the program is that framework" versus "no table
  // covers this number at all".
  return isAnchorBandCode(code)
    ? unresolved(code, rawCode, 'unattested-namespace', failingProgramId)
    : unresolved(code, rawCode, 'not-in-table', failingProgramId);
}

/**
 * Compose `locateFailure`'s output and a resolved error into a `FailureReport`.
 *
 * This is the join `resolve/failure.ts` documents in its header: that module
 * returns `FailureLocation` because it cannot construct a `FailureReport` without
 * inventing the `ResolvedError` this module produces. Every other field of the
 * report is copied through unchanged — including `cpiAttribution`, which is
 * unconditionally `null` in v1 (Req 5.5 is Phase 2).
 */
export function buildFailureReport(
  location: FailureLocation,
  err: RawTransactionError,
  idls: IdlStore | null,
  logs: LogReport,
): FailureReport {
  return {
    failingInstructionIndex: location.failingInstructionIndex,
    indexOutOfRange: location.indexOutOfRange,
    error: resolveError(err, location.failingProgramId, idls, logs),
    cpiAttribution: location.cpiAttribution,
  };
}

// ---------------------------------------------------------------------------
// The two attested branches
// ---------------------------------------------------------------------------

/**
 * Code ≥ 6000, attestation present: the program's own IDL governs (Req 6.1).
 *
 * The log line is preferred when it carries a message, because it is what the
 * program emitted during this execution while the IDL is a static artifact that
 * may describe another deployed version (Req 6.13).
 *
 * `no-idl` is reachable exactly when a matching `AnchorError` line attested the
 * program but named no message — a truncated log line is the realistic case — and
 * no IDL is loaded for it. Requirement 6.5 is that case: attestation exists, so
 * the namespace is not in doubt, but nothing available declares what the code
 * means.
 */
function resolveUserCode(
  code: number,
  rawCode: string,
  failingProgramId: Base58Address | null,
  idl: LoadedIdl | undefined,
  logLine: AnchorErrorLine | null,
  attestation: ErrorAttestation,
): ResolvedError {
  const fromLog = resolveFromLogLine(code, 'anchor-user', failingProgramId, logLine);
  if (fromLog !== null) return fromLog;

  if (idl === undefined) {
    return unresolved(code, rawCode, 'no-idl', failingProgramId);
  }

  const entry = idl.errors.find((candidate) => candidate.code === code);
  if (entry === undefined) {
    return unresolved(code, rawCode, 'not-in-table', failingProgramId);
  }

  // `entry.msg` may be null, and it is passed through as null. See deviation 1
  // in the header: the name is evidence, the absent message is not something to
  // fill in from it.
  return resolved(code, 'anchor-user', entry.name, entry.msg, attestation, failingProgramId);
}

/**
 * Code in 2000–5999, attestation present: the framework table governs (Req 6.2).
 *
 * `attestation` is passed through rather than recomputed, so a code whose
 * namespace was established by a log line but whose message came from the table
 * still records `'anchor-error-log'`. The field says what established the
 * *namespace*, which is the question a reviewer of an `expected.json` is asking.
 */
function resolveFrameworkCode(
  code: number,
  rawCode: string,
  failingProgramId: Base58Address | null,
  logLine: AnchorErrorLine | null,
  attestation: ErrorAttestation,
): ResolvedError {
  const fromLog = resolveFromLogLine(code, 'anchor-framework', failingProgramId, logLine);
  if (fromLog !== null) return fromLog;

  const entry: ErrorEntry | undefined = anchorFrameworkErrorTable.lookup(code);
  return entry === undefined
    ? unresolved(code, rawCode, 'not-in-table', failingProgramId)
    : resolved(
        code,
        anchorFrameworkErrorTable.namespace,
        entry.name,
        entry.message,
        attestation,
        failingProgramId,
      );
}

/**
 * The resolution a matching `AnchorError` line supports on its own, or `null`
 * when the line is absent or named no message.
 *
 * Requirement 6.13: name and message come from the line, not from a table. A
 * line that reports a number but no message supports no resolution here — it
 * still attested the program, and the caller decides what that licenses.
 */
function resolveFromLogLine(
  code: number,
  namespace: ErrorNamespace,
  failingProgramId: Base58Address | null,
  logLine: AnchorErrorLine | null,
): ResolvedError | null {
  if (logLine === null || logLine.name === null || logLine.message === null) return null;
  return resolved(
    code,
    namespace,
    logLine.name,
    logLine.message,
    'anchor-error-log',
    failingProgramId,
  );
}

// ---------------------------------------------------------------------------
// Variant constructors
// ---------------------------------------------------------------------------

function resolved(
  code: number,
  namespace: ErrorNamespace,
  name: string,
  message: string | null,
  attestation: ErrorAttestation,
  programId: Base58Address | null,
): ResolvedError {
  return { kind: 'resolved', code, namespace, name, message, attestation, programId, confidence: 'full' };
}

/**
 * The `unresolved` variant. **No `message` key is written here, by
 * construction** — not `null`, not `''`, absent. A message on this variant could
 * only be a guess, and the type has no field for one; this function is the only
 * place the variant is built, so that stays true of every value of it.
 */
function unresolved(
  code: number | null,
  rawCode: string,
  reason: UnresolvedErrorReason,
  programId: Base58Address | null,
): ResolvedError {
  return { kind: 'unresolved', code, rawCode, reason, programId, confidence: 'raw' };
}

// ---------------------------------------------------------------------------
// Reading the payload
// ---------------------------------------------------------------------------

type ErrorPayload =
  /** A `Custom` code, still uninterpreted: `value` is whatever the key held. */
  | { readonly kind: 'custom'; readonly value: unknown }
  | { readonly kind: 'non-custom'; readonly variant: string; readonly detail: string | null };

/**
 * Pull the `Custom` code out of `meta.err`, or name the variant that is there
 * instead.
 *
 * Every shape the runtime uses is handled, and every shape it does not:
 *
 * - `"AlreadyProcessed"` — a bare-string variant. `variant` is the string,
 *   `detail` is `null` because there is no payload to describe.
 * - `{ InstructionError: [i, { Custom: n }] }` — the `custom` case, `n` unread.
 * - `{ InstructionError: [i, "InvalidAccountData"] }` — a built-in runtime
 *   failure. The variant is the detail string.
 * - `{ InstructionError: [i, { BorshIoError: "..." }] }` — a data-carrying
 *   detail variant. The variant is the key, `detail` the value described.
 * - `{ DuplicateInstruction: 3 }` — a non-`InstructionError` object variant.
 * - Anything else, including an `InstructionError` whose tuple is not shaped as
 *   promised: reported as the outer variant name with the malformed payload
 *   described in `detail`, so the response is still shown rather than dropped.
 *
 * Where an object carries several keys — which the runtime never emits, but
 * untrusted JSON can — the first key by code-unit order is taken, so the same
 * response always reports the same variant regardless of key order (Req 9.6).
 */
function readErrorPayload(err: RawTransactionError): ErrorPayload {
  if (typeof err === 'string') {
    return { kind: 'non-custom', variant: err, detail: null };
  }

  if (typeof err !== 'object' || err === null) {
    // Not a shape the type admits; `JSON.parse` can still produce it.
    return { kind: 'custom', value: err };
  }

  const tuple: unknown = err['InstructionError'];
  if (tuple !== undefined) {
    if (!Array.isArray(tuple)) {
      return { kind: 'non-custom', variant: 'InstructionError', detail: spell(tuple) };
    }
    return readErrorDetail(tuple[1]);
  }

  const variant = firstKey(err);
  if (variant === null) {
    // An error object naming nothing at all. There is no variant to report and
    // no code to parse, so it is reported the way an unreadable code is, with
    // the payload preserved verbatim in `rawCode`.
    return { kind: 'custom', value: err };
  }

  return { kind: 'non-custom', variant, detail: spell(err[variant]) };
}

/** The detail element of `InstructionError`, by the same rules. */
function readErrorDetail(detail: unknown): ErrorPayload {
  if (typeof detail === 'string') {
    return { kind: 'non-custom', variant: detail, detail: null };
  }

  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
    return { kind: 'non-custom', variant: 'InstructionError', detail: spell(detail) };
  }

  const record = detail as Readonly<Record<string, unknown>>;
  if ('Custom' in record) {
    return { kind: 'custom', value: record['Custom'] };
  }

  const variant = firstKey(record);
  return variant === null
    ? { kind: 'non-custom', variant: 'InstructionError', detail: spell(detail) }
    : { kind: 'non-custom', variant, detail: spell(record[variant]) };
}

function firstKey(record: Readonly<Record<string, unknown>>): string | null {
  const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return keys[0] ?? null;
}

// ---------------------------------------------------------------------------
// The code itself
// ---------------------------------------------------------------------------

/**
 * The `Custom` value as an error code, or `null` when it is not one (Req 6.9).
 *
 * A JSON number is a code when it is a non-negative safe integer — the runtime
 * sends a u32, so `-1`, `1.5`, and `1e21` are all payloads that name no code.
 *
 * A string is accepted only in the two spellings that are exact: decimal digits,
 * or `0x`-prefixed hex. That is not leniency for its own sake; `rawCode` exists
 * to preserve the spelling `0x1771` precisely because a code can arrive written
 * that way, and parsing an exact base-16 integer invents nothing. Anything else
 * — empty, signed, spaced, `1e3`, `NaN` — is unparseable rather than guessed at.
 */
function parseCode(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  if (typeof value !== 'string') return null;

  const radix = /^[0-9]+$/.test(value) ? 10 : /^0[xX][0-9a-fA-F]+$/.test(value) ? 16 : null;
  if (radix === null) return null;

  const parsed = Number.parseInt(value, radix);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * How a value appeared, for `rawCode` and for `non-custom.detail`.
 *
 * A string is itself; anything else is JSON, so `{ Custom: null }` reports
 * `"null"` and a nested object reports its JSON text. The point is that the
 * reader of an unresolved error can see what actually arrived, which is the only
 * useful thing left to say about a payload nothing could be made of.
 */
function spell(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A circular structure cannot come from `JSON.parse`, but this function must
    // not be the thing that throws on a hand-built value.
    return String(value);
  }
}

function isFrameworkCode(code: number): boolean {
  return code >= FRAMEWORK_CODE_MIN && code <= FRAMEWORK_CODE_MAX;
}

/** Either Anchor band: the codes Requirement 6.11's attestation gate covers. */
function isAnchorBandCode(code: number): boolean {
  return isFrameworkCode(code) || code >= USER_CODE_MIN;
}

// ---------------------------------------------------------------------------
// Log attestation — Requirements 6.13, 6.15
// ---------------------------------------------------------------------------

/** What one `AnchorError` line reported, as far as it can be read. */
interface AnchorErrorLine {
  readonly name: string | null;
  readonly message: string | null;
}

/**
 * The three shapes Anchor's own `AnchorError::log` emits, all of which start with
 * the word `AnchorError` after the runtime's `Program log: ` prefix:
 *
 *     AnchorError occurred. Error Code: <Name>. Error Number: <n>. Error Message: <msg>.
 *     AnchorError thrown in <file>:<line>. Error Code: <Name>. Error Number: <n>. Error Message: <msg>.
 *     AnchorError caused by account: <name>. Error Code: <Name>. Error Number: <n>. Error Message: <msg>.
 *
 * The three fields are matched independently rather than by one whole-line
 * pattern. The prefix differs per shape, a truncated line may carry the number
 * and nothing after it, and `Error Message:` runs to end of line because a
 * message may contain any punctuation including the field separators.
 */
const ANCHOR_ERROR_MARKER = /AnchorError/;
const ERROR_NUMBER = /Error Number: (\d+)/;
const ERROR_CODE_NAME = /Error Code: ([A-Za-z0-9_]+)/;
const ERROR_MESSAGE = /Error Message: (.*)$/;

/**
 * The first `AnchorError` line whose reported number equals `code`, or `null`.
 *
 * **The number is the join key, and that is what makes this attestation rather
 * than a keyword search** (Req 6.15). A transaction usually invokes several
 * programs, so an `AnchorError` line proves only that *some* program on the call
 * path is Anchor. A line whose `Error Number` equals the code the transaction
 * failed with is evidence about the error being resolved.
 *
 * This does not need per-line log attribution (Req 21.2, Phase 2). It is a scan
 * of the verbatim array v1 already captures in full under Requirement 21.1,
 * which is why the strongest evidence tier ships in v1.
 *
 * The scan reads `logs.messages` in RPC order and stops at the first match; the
 * runtime emits one line per raised error, so a second match would mean two
 * programs raised the same number and the earlier line is the one this
 * transaction's error propagated from.
 */
function findAnchorErrorLine(
  messages: readonly string[],
  code: number,
): AnchorErrorLine | null {
  for (const line of messages) {
    if (!ANCHOR_ERROR_MARKER.test(line)) continue;

    const number = ERROR_NUMBER.exec(line)?.[1];
    if (number === undefined || Number.parseInt(number, 10) !== code) continue;

    return {
      name: ERROR_CODE_NAME.exec(line)?.[1] ?? null,
      message: readLogMessage(line),
    };
  }

  return null;
}

/**
 * The `Error Message:` field of a line, or `null` when it carries none.
 *
 * One trailing `.` is removed. That period is part of Anchor's log template —
 * upstream formats `Error Message: {}.` around the message — so removing exactly
 * one recovers the message the program declared, and removing no more than one
 * leaves a message that genuinely ends in a period intact. This is the only
 * transformation applied to the text; the words themselves are the program's.
 */
function readLogMessage(line: string): string | null {
  const captured = ERROR_MESSAGE.exec(line)?.[1];
  if (captured === undefined) return null;

  const trimmed = captured.trimEnd();
  const message = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  return message === '' ? null : message;
}
