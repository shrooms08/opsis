/**
 * Failing instruction location.
 *
 * Satisfies Requirements 5.1, 5.2, 5.3, 5.4.
 *
 * This module answers one question — *which instruction failed* — and refuses
 * the two neighbouring questions it would be easy to answer badly:
 *
 * - **What the error means** is `resolve/errorResolver.ts` (task 6.10, Req 6).
 *   Namespace selection, table lookup, and Anchor attestation are all a function
 *   of the error code and the failing program, and only the second of those is
 *   discovered here. So this module hands that stage what it found — the failing
 *   program ID and the raw error detail — and resolves nothing itself.
 * - **Whether a nested CPI frame is the real culprit** is Phase 2 (Req 5.5).
 *   `cpiAttribution` is `null` on every report this module produces; see
 *   `NO_CPI_ATTRIBUTION` for why that is a deferral with a reason rather than an
 *   unfinished field.
 *
 * ## The one fact everything here follows from
 *
 * `meta.err` in the form `{ InstructionError: [index, detail] }` carries a
 * **top-level** instruction index. Not a path, not a node identifier, not a CPI
 * frame — the runtime reports the index of the entry in
 * `message.instructions` whose execution ended the transaction, and nothing
 * about how deep inside that instruction's call graph the failure actually
 * occurred. That is a property of the error payload, not a limitation this tool
 * could engineer its way out of, and the design does not pretend otherwise: the
 * mark lands on the node at depth 0, and any claim about a nested frame has to
 * come from the program logs and carry `partial` confidence (Req 5.5).
 *
 * The temptation this module exists to resist is descending into `inner` to find
 * a "more precise" node. There is no evidence in `meta.err` licensing that
 * descent, and a mark on a plausible-looking child would be a confident wrong
 * answer pointing a reader at the wrong program.
 *
 * ## Deviations from design.md, both deliberate
 *
 * design.md gives the signature
 * `locateFailure(response, tree, logs: LogAttribution): FailureReport | null`.
 * Two differences:
 *
 * 1. **Return type.** A `FailureReport` cannot be constructed here: its `error`
 *    field is a `ResolvedError`, and producing one is task 6.10's whole job.
 *    Returning `FailureReport | null` from this module would force it to invent
 *    an error variant to satisfy the type — exactly the fabrication the
 *    confidence model exists to prevent. So it returns `FailureLocation`, which
 *    is a `FailureReport` minus the field it has no business filling, plus the
 *    two inputs task 6.10 needs. That task composes the two into the report.
 * 2. **No `logs` parameter.** `LogAttribution` is Phase 2 and does not exist,
 *    and the only thing this module would have used it for is `cpiAttribution`,
 *    which is unconditionally `null`. A parameter that is accepted and ignored
 *    reads as a wiring bug at every call site; the parameter arrives with the
 *    attribution that needs it.
 *
 * The marked tree comes back alongside the report rather than being mutated in
 * place, because `InstructionNode` is deeply `readonly` and the pipeline's stages
 * are pure functions of their inputs.
 *
 * Pure and total: reads only its arguments, mutates nothing it was given, throws
 * on no input.
 */

import { mapInstructionTree } from '../analyze/assemble.js';
import type { Base58Address, CpiAttribution, InstructionNode } from '../model/analysis.js';
import type {
  RawInstructionErrorDetail,
  RawTransactionError,
  RawTransactionResponse,
} from '../model/rawResponse.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Where the failure is, and what task 6.10 needs to say what it was.
 *
 * The first three fields are `FailureReport`'s, unchanged in meaning. The last
 * two are the hand-off: `failingProgramId` is the program whose namespace
 * governs the error code (Req 6.8), and `errorDetail` is the second element of
 * `InstructionError` verbatim, unparsed.
 */
export interface FailureLocation {
  /**
   * The top-level index as `InstructionError` spelled it (Req 5.1), preserved
   * even when it names no instruction (Req 5.4). `null` when the error payload
   * carries no index at all — see `locateFailure`.
   */
  readonly failingInstructionIndex: number | null;
  /** True when the index names no top-level instruction (Req 5.4). */
  readonly indexOutOfRange: boolean;
  /**
   * Program ID of the marked instruction, or `null` when no node was marked.
   * The namespace selector for Requirement 6.8.
   */
  readonly failingProgramId: Base58Address | null;
  /**
   * `InstructionError`'s detail element, verbatim and uninterpreted — a bare
   * string for a built-in runtime failure, or `{ Custom: n }` and friends.
   * `null` when the payload carried no usable detail.
   */
  readonly errorDetail: RawInstructionErrorDetail | null;
  /** Always `null` in v1. See `NO_CPI_ATTRIBUTION`. */
  readonly cpiAttribution: CpiAttribution | null;
}

/**
 * The located failure and the tree it was located in.
 *
 * `instructions` is always a rewritten tree, never the input array, including on
 * success — Requirement 5.3 demands that `failed` be forced to `false`
 * everywhere on a successful transaction *overriding any earlier assignment*,
 * and "we did not touch it" is not the same guarantee as "we set it".
 */
export interface LocatedFailure {
  /** `null` exactly when the transaction succeeded. */
  readonly failure: FailureLocation | null;
  /** The input tree with `failed` set on every node at every depth. */
  readonly instructions: readonly InstructionNode[];
}

/**
 * Locate the failing instruction and mark it.
 *
 * Four cases, and the distinction between the last two is the point:
 *
 * - **`meta.err === null`, or no metadata at all.** The transaction succeeded,
 *   or nothing recorded says it did not. `failure` is `null` and every node at
 *   every depth is forced to `failed: false` (Req 5.3).
 * - **`{ InstructionError: [index, detail] }` with an in-range index.** The
 *   index-th node at depth 0 gets `failed: true` and no other node at any depth
 *   does (Req 5.2).
 * - **`{ InstructionError: [index, detail] }` with an index naming no top-level
 *   instruction.** `indexOutOfRange` is `true`, `failingInstructionIndex` holds
 *   the value exactly as it arrived, and nothing is marked (Req 5.4). The value
 *   is not clamped into range: clamping would move the mark onto a real
 *   instruction that the runtime never accused, turning a detectable
 *   inconsistency in the response into a confident lie about which instruction
 *   failed. An index that is negative or not a safe integer lands here too —
 *   it names no instruction either, and the report says so in the one field that
 *   exists for saying it.
 * - **Any other error payload** — a bare string variant like
 *   `"AlreadyProcessed"`, an object variant like `{ DuplicateInstruction: 3 }`,
 *   or an `InstructionError` whose tuple is not shaped as promised. The
 *   transaction failed, so there is a report, but no index is invented for it:
 *   `failingInstructionIndex` is `null`, `indexOutOfRange` is `false` (nothing
 *   was out of range because nothing was in the payload), and no node is
 *   marked. Requirement 5.2 conditions the mark on the error *containing* an
 *   index; this is the case where it does not.
 */
export function locateFailure(
  response: RawTransactionResponse,
  tree: readonly InstructionNode[],
): LocatedFailure {
  // Absent metadata carries no evidence of a failure, and inventing one from
  // missing data is a stronger claim than either fact supports. Matches
  // `transactionOutcome` in `pipeline.ts`, which reads success the same way.
  const err = response.meta?.err ?? null;
  if (err === null) {
    return { failure: null, instructions: markFailed(tree, null) };
  }

  const payload = readInstructionError(err);
  if (payload === null) {
    return { failure: UNLOCATED_FAILURE, instructions: markFailed(tree, null) };
  }

  // Sorted and filtered rather than subscripted directly: the index counts
  // top-level instructions (Req 5.2), so nodes at any other depth are not
  // candidates, and `order` is the published appearance order (Req 3.4) rather
  // than whatever order this array happens to arrive in.
  const topLevel = tree.filter((node) => node.depth === 0).sort((a, b) => a.order - b.order);
  const target = isTopLevelIndex(payload.index, topLevel.length)
    ? topLevel[payload.index]
    : undefined;

  if (target === undefined) {
    return {
      failure: {
        failingInstructionIndex: payload.index,
        indexOutOfRange: true,
        // No node was marked, so there is no failing program. Reaching for
        // `topLevel[0]` or the last instruction would hand task 6.10 a
        // namespace selector picked at random.
        failingProgramId: null,
        errorDetail: payload.detail,
        cpiAttribution: NO_CPI_ATTRIBUTION,
      },
      instructions: markFailed(tree, null),
    };
  }

  return {
    failure: {
      failingInstructionIndex: payload.index,
      indexOutOfRange: false,
      // `null` when the program index itself was unresolvable (Req 3.7); task
      // 6.10 then has no namespace to select and says so.
      failingProgramId: target.programId,
      errorDetail: payload.detail,
      cpiAttribution: NO_CPI_ATTRIBUTION,
    },
    instructions: markFailed(tree, target.order),
  };
}

// ---------------------------------------------------------------------------
// The Phase 2 deferral, named
// ---------------------------------------------------------------------------

/**
 * `cpiAttribution` on every report this module produces.
 *
 * Requirement 5.5 attributes a failure to a nested CPI frame **where the program
 * logs permit it**, and that "where" is the whole constraint: the evidence is a
 * marker sequence in `meta.logMessages`, and a `CpiAttribution` value is
 * required to carry the log lines it rests on in its `evidence` array at
 * `partial` confidence. Nothing in `meta.err` supplies that evidence, and this
 * module reads nothing else — log parsing lives in `resolve/logs.ts` and
 * per-line attribution is Phase 2 (Req 21.2).
 *
 * So the value is `null` unconditionally, and it is `null` because the evidence
 * that would license anything else has not been gathered, not because a field
 * was left unfinished. Constructing an attribution from the top-level mark alone
 * would be a `partial`-confidence claim about a nested frame backed by no log
 * line at all, with an empty `evidence` array advertising exactly that.
 */
const NO_CPI_ATTRIBUTION: CpiAttribution | null = null;

/**
 * The report for a failure whose payload names no instruction index.
 *
 * A shared constant because it is a single value, not a family: none of its
 * fields varies with the response. `errorDetail` is `null` rather than the raw
 * payload because task 6.10 reads `meta.err` itself for the non-`InstructionError`
 * variants (design.md's `resolveError` takes the whole error), and a partial copy
 * here would be a second source of truth for the same bytes.
 */
const UNLOCATED_FAILURE: FailureLocation = {
  failingInstructionIndex: null,
  indexOutOfRange: false,
  failingProgramId: null,
  errorDetail: null,
  cpiAttribution: NO_CPI_ATTRIBUTION,
};

// ---------------------------------------------------------------------------
// Marking
// ---------------------------------------------------------------------------

/**
 * Rewrite every node's `failed` flag, at every depth.
 *
 * Assignment, never mutation of the flag in place: `failed` is set to whether
 * this node's `order` is the failing one, so whatever any earlier stage put
 * there is overwritten. That is what makes Requirement 5.3 hold as stated —
 * "overriding any previously assigned failed value" — with `failingOrder` of
 * `null` clearing the whole tree.
 *
 * `order` is the match key, not object identity or position, because it is
 * unique across the whole transaction at every depth (Req 3.4). So exactly one
 * node can match, and Property 15's "exactly one node in the whole tree" is a
 * consequence of the key rather than something checked afterwards.
 *
 * Reuses `mapInstructionTree` rather than recursing here. The walk is iterative
 * so an unbounded CPI chain (Req 3.6) cannot exhaust the stack, and a second
 * copy of it would be a copy that drifts — the failure mode of drift on this
 * particular walk being a silently mis-shaped tree.
 */
function markFailed(
  tree: readonly InstructionNode[],
  failingOrder: number | null,
): readonly InstructionNode[] {
  return mapInstructionTree(tree, (node, inner) => ({
    ...node,
    failed: failingOrder !== null && node.order === failingOrder,
    inner,
  }));
}

/**
 * Whether an index names a top-level instruction.
 *
 * `Number.isSafeInteger` is part of the test rather than an afterthought: the
 * index arrives from parsed JSON, so `1.5`, `-1`, `NaN`, and `1e21` are all
 * reachable values, and each of them names no instruction for the same reason a
 * too-large index does.
 */
function isTopLevelIndex(index: number, topLevelCount: number): boolean {
  return Number.isSafeInteger(index) && index >= 0 && index < topLevelCount;
}

// ---------------------------------------------------------------------------
// Reading the error payload
// ---------------------------------------------------------------------------

interface InstructionErrorPayload {
  readonly index: number;
  readonly detail: RawInstructionErrorDetail | null;
}

/**
 * Read `{ InstructionError: [index, detail] }`, or `null` for anything else.
 *
 * Every field is checked at runtime even though `RawTransactionErrorObject`
 * declares the tuple's shape. That declaration describes what a well-behaved
 * node sends; the value itself came out of `JSON.parse` and is untrusted, per
 * the contract at the top of `model/rawResponse.ts`. A trusted read here would
 * put a string or an object where `failingInstructionIndex: number | null`
 * promises a number, and the lie would surface as a nonsense index in the
 * rendered output rather than as a type error.
 */
function readInstructionError(err: RawTransactionError): InstructionErrorPayload | null {
  // The bare-string variants (`"AlreadyProcessed"`) carry no index by
  // construction.
  if (typeof err !== 'object') return null;

  const tuple: unknown = err['InstructionError'];
  if (!Array.isArray(tuple)) return null;

  const index: unknown = tuple[0];
  if (typeof index !== 'number') return null;

  const detail: unknown = tuple[1];
  return { index, detail: isErrorDetail(detail) ? detail : null };
}

/**
 * Whether the detail element is one of the two shapes the runtime uses: a bare
 * string, or a single-key object. Anything else — absent, `null`, a number, an
 * array — is not a detail, and is reported as its absence rather than passed
 * along for task 6.10 to re-check.
 */
function isErrorDetail(detail: unknown): detail is RawInstructionErrorDetail {
  if (typeof detail === 'string') return true;
  return typeof detail === 'object' && detail !== null && !Array.isArray(detail);
}
