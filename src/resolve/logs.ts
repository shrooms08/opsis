/**
 * Program log capture (v1) and the reusable log scope walker.
 *
 * Satisfies Requirements 21.1, 21.5, 21.6.
 *
 * Two exports live here, and they are deliberately unrelated in what they claim:
 *
 * - `captureLogs` copies `meta.logMessages` through, verbatim. It parses
 *   nothing, marks no line, and associates no line with any instruction.
 * - `walkLogScopes` parses the invoke/terminate marker sequence into nested
 *   scopes. It is the one place in v1 that reads structure out of the log
 *   stream, and it attaches nothing to any node.
 *
 * **Why verbatim capture ships in v1 rather than being deferred with the rest of
 * the log work.** Anchor programs emit the resolved error message straight into
 * the log stream, so on a failed transaction the log array is frequently the
 * single most informative artifact in the whole response. The recorded evidence
 * is in `tests/golden/02-anchor-user-error/input.json`, whose log array contains
 *
 *     Program log: AnchorError thrown in programs/pump-amm/src/instructions/
 *     swap/buy.rs:687. Error Code: BuySlippageBelowMinBaseAmountOut. Error
 *     Number: 6040. Error Message: buy: slippage - would buy less tokens than
 *     expected min_base_amount_out.
 *
 * — the program naming its own error, in its own words, with the code that
 * `meta.err` reports only as `0x1798`. Withholding that pending a nicer
 * presentation would contradict the product thesis: the tool exists to surface
 * what is already there.
 *
 * `LogReport.unattributed` is empty here, and that emptiness is the Phase 2
 * deferral rather than a defect — `messages` already carries every line, so no
 * line is lost by not being placed. `attributeLogs` and `LogAttribution`
 * (Requirements 21.2, 21.3, 21.4) are Phase 2 and are not implemented in this
 * module yet.
 *
 * Neither function throws, and neither writes to a stream.
 */

import type { Base58Address, LogReport } from '../model/analysis.js';
import type { RawTransactionResponse } from '../model/rawResponse.js';

// ---------------------------------------------------------------------------
// v1 — verbatim capture
// ---------------------------------------------------------------------------

/**
 * The exact line the runtime appends when the per-transaction log byte budget is
 * exhausted. Truncation is reported inside the array itself; there is no
 * separate metadata flag to read (Req 21.5).
 */
const TRUNCATION_MARKER = 'log truncated';

/**
 * Copy `meta.logMessages` into a `LogReport`, unchanged.
 *
 * Requirements 21.1, 21.5, 21.6.
 *
 * `messages` is the RPC array in RPC order with nothing rewritten, reordered,
 * filtered, or marked — including the truncation line, which stays in place as
 * the node sent it. Two facts about the collection are determined alongside it:
 * `present` is false when the field is absent (Req 21.6), and `truncated` is
 * true when the metadata indicates the array was cut short (Req 21.5). The
 * collection-level `confidence` follows from exactly those two facts: `full`
 * when present and untruncated, `partial` when present and truncated, `raw`
 * when absent.
 */
export function captureLogs(response: RawTransactionResponse): LogReport {
  const raw = response.meta?.logMessages;

  // Absent and explicit `null` are the same fact — the node recorded no logs —
  // and both are the Requirement 21.6 case. `meta` itself being null lands here
  // too, for the same reason.
  if (raw === undefined || raw === null) {
    return {
      messages: [],
      present: false,
      truncated: false,
      unattributed: [],
      confidence: 'raw',
    };
  }

  const messages: readonly string[] = [...raw];
  const truncated = isTruncated(messages);

  return {
    messages,
    present: true,
    truncated,
    unattributed: [],
    confidence: truncated ? 'partial' : 'full',
  };
}

/**
 * Whether the metadata says the log array was cut short.
 *
 * Only the final element is examined. The runtime appends its truncation line
 * last and once, so a mid-stream occurrence of the same text is program-emitted
 * content rather than a statement about the response, and reading it as a
 * truncation flag would let a program describe the completeness of data it does
 * not control.
 */
function isTruncated(messages: readonly string[]): boolean {
  const last = messages[messages.length - 1];
  return last !== undefined && last.trim().toLowerCase() === TRUNCATION_MARKER;
}

// ---------------------------------------------------------------------------
// The scope walker — v1 reads depth-1 scopes, Phase 2 reads all of them
// ---------------------------------------------------------------------------

/**
 * One program invocation scope, delimited by its markers in the log array.
 *
 * `openIndex` and `closeIndex` are the marker lines; `lineIndices` is everything
 * the scope itself emitted between them. See `walkLogScopes` for the exact
 * boundaries.
 */
export interface LogScope {
  /** Invoke depth from the `invoke [n]` marker; 1 for a top-level invocation. */
  readonly depth: number;
  readonly programId: Base58Address;
  /** Index of the `invoke [n]` line in the messages array. */
  readonly openIndex: number;
  /** Index of the terminating success or failure line, or null if unbalanced. */
  readonly closeIndex: number | null;
  readonly lineIndices: readonly number[];
}

/**
 * Parse the marker sequence into nested invocation scopes.
 *
 * **This is a general depth-tracking scope walker, not a compute-specific
 * scanner, and that is the point.** v1 consumes only the `depth === 1` scopes
 * and only to read compute values out of them (`analyze/compute.ts`, Req 8), so
 * neither `depth` beyond the equality test nor `lineIndices` at all has a v1
 * reader. Both are here because Phase 2 maintains this same stack at every
 * depth and attaches the collected lines to nodes (Req 21.2). A parser
 * special-cased to one line shape at one depth would have to be thrown away and
 * rewritten, which is the outcome to avoid.
 *
 * Recognized markers, all of which must match a whole line:
 *
 * - `Program <id> invoke [n]` opens a scope at depth `n`.
 * - `Program <id> success` and `Program <id> failed: <reason>` close the
 *   innermost open scope whose program id is `<id>`.
 * - `Program failed to complete` carries no id and closes the innermost open
 *   scope whatever it is, which is what the runtime means by it.
 *
 * The program id must be base58-shaped and of address length. That is the cheap
 * discriminator against program-emitted text that merely resembles a marker;
 * `tests/golden/03-program-table-error` shows a program writing the bare line
 * `Transfer: insufficient lamports 1588537, need 2039280` into the stream, so
 * arbitrary text at any position is a real input, not a hypothetical one.
 *
 * Scope boundaries:
 *
 * - `lineIndices` holds the lines this scope emitted directly. It excludes its
 *   own open and close markers, which are `openIndex` and `closeIndex`, every
 *   marker line of a nested scope, and every line a nested scope emitted. The
 *   assignment is exclusive, so each line index appears in at most one scope,
 *   which is what makes `Program <id> consumed N of M compute units` land on the
 *   invocation that spent the units rather than on its caller.
 *
 * Totality. Every input is a `LogScope[]`; nothing throws and nothing is
 * asserted:
 *
 * - An unclosed scope gets `closeIndex: null`. So does a scope that is still
 *   open when a close marker for something further down the stack arrives — the
 *   sequence is unbalanced there, and the honest report is that the boundary is
 *   unknown rather than a guess at which marker belonged to it.
 * - A close marker matching no open scope is not a scope, and is treated as
 *   ordinary content of whatever scope is innermost, or dropped when the stack
 *   is empty.
 * - `depth` is reported as the marker spelled it, not as the stack height. The
 *   two can disagree on adversarial input, and when they do, the marker is the
 *   observation and the stack height would be an inference. A forged depth
 *   inflates the depth-1 scope count, which is exactly the disagreement task 8.4
 *   checks before attributing any compute value.
 *
 * Returned scopes are ordered by `openIndex` ascending, so the k-th `depth === 1`
 * scope is the k-th top-level invocation in the log stream.
 */
export function walkLogScopes(messages: readonly string[]): readonly LogScope[] {
  /** Scope records in open order, mutated in place as scopes close. */
  const records: MutableScope[] = [];
  /** Indices into `records` for the scopes currently open, innermost last. */
  const stack: number[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const line = messages[index];
    if (line === undefined) continue;

    const marker = classifyMarker(line);

    if (marker.kind === 'open') {
      records.push({
        depth: marker.depth,
        programId: marker.programId,
        openIndex: index,
        closeIndex: null,
        lineIndices: [],
      });
      stack.push(records.length - 1);
      continue;
    }

    if (marker.kind === 'close') {
      const match = findOpenScope(records, stack, marker.programId);
      if (match === null) {
        // A terminating marker with no matching invoke. Not a scope; it is text
        // that arrived where a scope boundary would have been.
        recordContentLine(records, stack, index);
        continue;
      }
      match.scope.closeIndex = index;
      // Everything above the matched scope was left open by an unbalanced
      // sequence. Those records keep `closeIndex: null`.
      stack.length = match.position;
      continue;
    }

    recordContentLine(records, stack, index);
  }

  return records.map(freezeScope);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface MutableScope {
  readonly depth: number;
  readonly programId: Base58Address;
  readonly openIndex: number;
  closeIndex: number | null;
  readonly lineIndices: number[];
}

type Marker =
  | { readonly kind: 'open'; readonly programId: Base58Address; readonly depth: number }
  /** `programId` is null for the id-less `Program failed to complete` line. */
  | { readonly kind: 'close'; readonly programId: Base58Address | null }
  | { readonly kind: 'none' };

const NONE: Marker = { kind: 'none' };

/**
 * Base58 (Bitcoin alphabet) address shape. A Solana address is 32 bytes, which
 * encodes to 32-44 base58 characters — `11111111111111111111111111111111` sits
 * at the low end of that range and is a real program id.
 */
const OPEN_MARKER = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const SUCCESS_MARKER = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) success$/;
const FAILURE_MARKER = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: .+$/;
const ANONYMOUS_FAILURE_MARKER = /^Program failed to complete$/;

/** Classify one line. Anything unrecognized is content, never an error. */
function classifyMarker(line: string): Marker {
  const open = OPEN_MARKER.exec(line);
  if (open !== null) {
    const programId = open[1];
    const rawDepth = open[2];
    if (programId === undefined || rawDepth === undefined) return NONE;
    const depth = Number.parseInt(rawDepth, 10);
    // A depth that is not a positive safe integer is not a depth. Leading zeros
    // and absurd lengths both land here rather than opening a nonsense scope.
    if (!Number.isSafeInteger(depth) || depth < 1) return NONE;
    return { kind: 'open', programId, depth };
  }

  const success = SUCCESS_MARKER.exec(line);
  if (success !== null && success[1] !== undefined) {
    return { kind: 'close', programId: success[1] };
  }

  const failure = FAILURE_MARKER.exec(line);
  if (failure !== null && failure[1] !== undefined) {
    return { kind: 'close', programId: failure[1] };
  }

  if (ANONYMOUS_FAILURE_MARKER.test(line)) {
    return { kind: 'close', programId: null };
  }

  return NONE;
}

/**
 * The open scope a close marker terminates, with its position in `stack`, or
 * null when nothing open matches.
 *
 * An id-less marker closes the innermost open scope. An id-bearing one closes
 * the innermost open scope with that id, searching outward, so a program's own
 * success marker still closes its scope when a callee's scope was left open.
 */
function findOpenScope(
  records: readonly MutableScope[],
  stack: readonly number[],
  programId: Base58Address | null,
): { readonly position: number; readonly scope: MutableScope } | null {
  for (let position = stack.length - 1; position >= 0; position -= 1) {
    const recordIndex = stack[position];
    if (recordIndex === undefined) continue;
    const scope = records[recordIndex];
    if (scope === undefined) continue;
    if (programId === null || scope.programId === programId) return { position, scope };
  }
  return null;
}

/** Attribute a non-marker line to the innermost open scope, if there is one. */
function recordContentLine(
  records: readonly MutableScope[],
  stack: readonly number[],
  index: number,
): void {
  const recordIndex = stack[stack.length - 1];
  if (recordIndex === undefined) return;
  const record = records[recordIndex];
  if (record === undefined) return;
  record.lineIndices.push(index);
}

function freezeScope(scope: MutableScope): LogScope {
  return {
    depth: scope.depth,
    programId: scope.programId,
    openIndex: scope.openIndex,
    closeIndex: scope.closeIndex,
    lineIndices: [...scope.lineIndices],
  };
}
