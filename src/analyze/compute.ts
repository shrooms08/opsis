/**
 * Compute unit extraction — the transaction total verbatim from metadata, and
 * top-level per-instruction values paired positionally with the outermost log
 * scopes.
 *
 * Satisfies Requirements 8.1, 8.2, 8.3, 8.4, 8.5.
 *
 * Four rules carry this module:
 *
 * - **The total is read, not derived.** `meta.computeUnitsConsumed` is copied
 *   through as it arrived (Req 8.5). It is never summed, never reconciled
 *   against the per-instruction values, and never adjusted. `meta.costUnits` is
 *   a different figure and is not read here.
 * - **Absence is a variant, not a zero.** A genuine zero is reported as the
 *   `available: true` variant carrying `0` (Req 8.4); an absent or unusable
 *   value is the `available: false` variant, which has no `value` key at all
 *   (Req 8.2). That is the whole reason the union is shaped the way it is — a
 *   placeholder zero would be indistinguishable from a measurement of zero.
 * - **Positional pairing, or nothing.** The k-th outermost scope supplies the
 *   value for the k-th node at depth 0, and only when the scope count matches
 *   what the response says it should be. When it does not, every top-level node
 *   degrades to `available: false` rather than taking a positional guess.
 *   Attributing a real number to the wrong instruction is worse than reporting
 *   no number, because the wrong number is indistinguishable from a right one.
 * - **Nested nodes are unattributed by deferral, not by failure.** Every node
 *   below depth 0 gets `available: false` at `raw` confidence. That is the
 *   Phase 2 per-line attribution deferral (Req 21.2), named as such, and not
 *   missing RPC data of unknown cause.
 *
 * ## Deviation from design.md: an *expected* scope count, not a flat equality
 *
 * design.md's step 3 guard is that the outermost scope count **equals** the
 * top-level instruction count. Measured against the six recorded fixtures, that
 * equality holds on **2 of 6** (`01-success-cpi-heavy` and
 * `04-unattested-band-collision`). On the other four the count is exactly
 * `failingInstructionIndex + 1`:
 *
 * | fixture | top-level | outermost scopes | failing index |
 * | --- | --- | --- | --- |
 * | `01-success-cpi-heavy` | 5 | 5 | — (success) |
 * | `02-anchor-user-error` | 7 | 5 | 4 |
 * | `03-program-table-error` | 9 | 4 | 3 |
 * | `04-unattested-band-collision` | 6 | 6 | 5 |
 * | `06-nested-cpi-failure` | 6 | 4 | 3 |
 * | `07-unknown-program` | 5 | 3 | 2 |
 *
 * The cause is not a parsing defect and not an unknowable alignment: **execution
 * halts at the failing instruction, so the instructions after it never run and
 * emit no scope.** Applied literally, the equality check would therefore discard
 * every top-level compute value on 4 of 6 fixtures — including all four failed
 * transactions, which are the tool's primary use case.
 *
 * So the guard here compares the actual count against an **expected** count
 * derived from the outcome the response itself reports:
 *
 * - Success → expected count is the top-level instruction count.
 * - Failure with an in-range `failingInstructionIndex` → expected count is
 *   `failingInstructionIndex + 1`. Scopes `0..failingIndex` pair positionally;
 *   every top-level instruction after the failing one is `available: false` with
 *   the `never-executed` reason.
 * - Anything else → every top-level node degrades.
 *
 * This preserves the spec's intent rather than weakening it. The rule design.md
 * is enforcing is *never pair when the alignment is unknown*, and the truncated
 * tail is a known alignment: the k-th scope still belongs to the k-th top-level
 * instruction, and the tail simply did not execute. The check is in fact
 * **stricter** than a flat equality on failed transactions — a flat equality
 * would accept any count that happened to match the instruction count, whereas
 * this rejects a failed transaction whose scope count disagrees with where the
 * runtime says it stopped. `04-unattested-band-collision` satisfies both rules
 * at once, its failure being in the last instruction.
 *
 * The `never-executed` case gets its own reason wording rather than reusing the
 * unattributed one, because "the runtime never ran this" is a different fact from
 * "this tool did not attribute a value", and conflating them would tell a reader
 * the tool fell short when the runtime is what stopped.
 *
 * ## Why no `partial` confidence on the truncated tail
 *
 * `ComputeUnits` admits exactly two variants — `available: true` at `full` and
 * `available: false` at `raw` — with no `partial` spelling and no field for a
 * reason. Widening that union is out of scope for this task and would touch a
 * type three other modules already construct, so the model type is left exactly
 * as it is and the nuance is carried in `ComputeAnalysis.unattributed`, the same
 * side-channel convention `analyze/balances.ts` uses for its `unrepresented`
 * collection. A reader of the analysis object sees `available: false`; a reader
 * of this module's output additionally sees *which* of the four reasons applied.
 *
 * ## The failure mode, stated plainly
 *
 * **Silent misattribution.** If the pairing is wrong, a compute value lands on
 * the wrong instruction and the output looks entirely plausible on screen —
 * nothing about a number in the right shape and range signals it came from the
 * neighbouring instruction. The count check catches a mispairing that changes
 * the scope count; it cannot catch one that preserves it. The mitigation is that
 * task 9's golden fixtures pin the per-instruction value for every top-level
 * instruction, so a shift between adjacent nodes fails a golden test.
 *
 * Two narrower guards work against the same failure mode: the consumed line must
 * name the scope's own program, and the *last* such line before the terminating
 * marker wins, so a program that writes a look-alike line into its own output
 * cannot displace the runtime's.
 *
 * Every function here is pure and total. Nothing throws on any input, nothing
 * mutates what it was given, and no value is read outside the arguments.
 */

import type {
  ComputeReport,
  ComputeUnits,
  InstructionNode,
} from '../model/analysis.js';
import type { RawTransactionResponse } from '../model/rawResponse.js';
import type { FailureLocation } from '../resolve/failure.js';
import type { LogScope } from '../resolve/logs.js';
import { captureLogs, walkLogScopes } from '../resolve/logs.js';
import { mapInstructionTree } from './assemble.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Why a top-level instruction carries no compute value. */
export type UnattributedComputeReason =
  /**
   * The instruction never ran: the transaction failed at an earlier instruction
   * and the runtime stopped before reaching this one, so it emitted no scope.
   * A fact about the runtime, not about this tool.
   */
  | 'never-executed'
  /**
   * The scope paired with this instruction, but emitted no
   * `consumed N of M compute units` line. Native loader programs routinely do
   * not — see `ComputeAnalysis.unattributed`.
   */
  | 'no-compute-line'
  /**
   * The scope count could not be reconciled with the response, so no positional
   * pairing was made anywhere. Every top-level node carries this reason.
   */
  | 'alignment-unknown';

/** Why the positional pairing was abandoned for the whole transaction. */
export type ComputeDegradeReason =
  /** `meta.logMessages` absent or null; there is no scope sequence to read. */
  | 'logs-absent'
  /** The log array was cut short, so the scope sequence is incomplete. */
  | 'logs-truncated'
  /** Some scope never closed; the marker sequence is unbalanced. */
  | 'unbalanced-scopes'
  /** The transaction failed but named no instruction index. */
  | 'failing-index-absent'
  /** The failing index names no top-level instruction (Req 5.4). */
  | 'failing-index-out-of-range'
  /** The scope count matched neither the success nor the failure expectation. */
  | 'scope-count-mismatch';

/**
 * One top-level instruction with no compute value, and why.
 *
 * Ascending by `order`. Nested instructions are deliberately absent: their
 * `available: false` is an unconditional blanket deferral covering every node
 * below depth 0, so a per-node record would restate one rule thousands of times
 * and carry no information the rule does not already give.
 */
export interface UnattributedCompute {
  /** The node's global `order` (Req 3.4). */
  readonly order: number;
  readonly reason: UnattributedComputeReason;
}

/** The outcome of the scope-count check, kept for diagnostics and testing. */
export type ComputeAlignment =
  | {
      readonly kind: 'aligned';
      /** Outermost scopes observed, which equals `expectedScopeCount`. */
      readonly scopeCount: number;
      readonly expectedScopeCount: number;
      /**
       * Top-level instructions the runtime reached. Equal to the instruction
       * count on success, and to `failingInstructionIndex + 1` on a failure.
       */
      readonly executedCount: number;
    }
  | {
      readonly kind: 'degraded';
      readonly reason: ComputeDegradeReason;
      readonly scopeCount: number;
      /** `null` when no expectation could be formed in the first place. */
      readonly expectedScopeCount: number | null;
    };

export interface ComputeAnalysis {
  /** `total` verbatim from metadata; never derived from the values below. */
  readonly compute: ComputeReport;
  /**
   * The input tree with `computeUnits` assigned on every node at every depth,
   * in the order it arrived. Every other field is carried through untouched.
   */
  readonly instructions: readonly InstructionNode[];
  /** Ascending by `order`. Top-level nodes only; see `UnattributedCompute`. */
  readonly unattributed: readonly UnattributedCompute[];
  readonly alignment: ComputeAlignment;
}

/**
 * Read the transaction total and attribute top-level per-instruction values.
 *
 * `instructions` is the top-level instruction list, already marked by
 * `locateFailure`; nested nodes are reached through `inner`. `failure` is
 * `LocatedFailure.failure` — `null` exactly when the transaction succeeded —
 * and it is a parameter rather than something recomputed here because the
 * pipeline has already located the failure, and a second read of `meta.err`
 * would be a second source of truth for where execution stopped.
 *
 * The returned `compute.total` is independent of everything else in the return
 * value (Req 8.5): it is read from metadata before any log line is examined, and
 * no code path below can change it. In particular a fully degraded attribution
 * still reports the total, and a total of `0` does not make any instruction's
 * value zero.
 */
export function analyzeCompute(
  response: RawTransactionResponse,
  instructions: readonly InstructionNode[],
  failure: FailureLocation | null,
): ComputeAnalysis {
  const total = readTotalComputeUnits(response);

  // Sorted and filtered rather than subscripted directly, matching
  // `locateFailure`: the pairing counts top-level instructions, and `order` is
  // the published appearance order (Req 3.4) rather than whatever order this
  // array arrived in.
  const topLevel = instructions
    .filter((node) => node.depth === 0)
    .sort((a, b) => a.order - b.order);

  const logs = captureLogs(response);
  const scopes = logs.present ? walkLogScopes(logs.messages) : [];
  const alignment = checkAlignment(logs.present, logs.truncated, scopes, topLevel.length, failure);

  const attributed = attribute(topLevel, outermost(scopes), logs.messages, alignment);

  return {
    compute: { total },
    instructions: assign(instructions, attributed.units),
    unattributed: attributed.unattributed,
    alignment,
  };
}

/**
 * `meta.computeUnitsConsumed`, verbatim.
 *
 * Requirements 8.1, 8.2, 8.4, 8.5.
 *
 * A present, non-negative, safe-integer value is reported as itself — including
 * `0`, which is a measurement and not an absence (Req 8.4). Everything else is
 * the `available: false` variant at `raw` confidence (Req 8.2): the field
 * missing, an explicit `null`, and a value that is not a non-negative integer
 * all name no compute total, and reporting `0` for any of them would state that
 * the transaction consumed nothing.
 *
 * The type check is not redundant with `RawMeta`'s declaration. That declaration
 * describes what a well-behaved node sends; this value came out of `JSON.parse`
 * and is untrusted, per the contract in `model/rawResponse.ts`. `-1`, `1.5`, and
 * a string all reach this line, and a trusted read would put each of them in a
 * field promising a non-negative integer.
 */
export function readTotalComputeUnits(response: RawTransactionResponse): ComputeUnits {
  const raw: unknown = response.meta?.computeUnitsConsumed;
  if (!isNonNegativeInteger(raw)) return UNAVAILABLE;
  return { available: true, value: raw, confidence: 'full' };
}

// ---------------------------------------------------------------------------
// The two deferrals and the one absence, named
// ---------------------------------------------------------------------------

/**
 * The `available: false` variant, shared because it is a single value rather
 * than a family — neither field varies with anything observed.
 *
 * Note what it does not have: a `value` key. That is the Requirement 8.2
 * guarantee in the type system rather than in a convention, and it is what keeps
 * a genuine `0` (Req 8.4) distinguishable from an absence when the analysis is
 * serialized — `available: false` serializes with no `value` at all, so a reader
 * sees explicitly that no value was attributed.
 */
const UNAVAILABLE: ComputeUnits = { available: false, confidence: 'raw' };

/**
 * `computeUnits` on every node below depth 0.
 *
 * This is the Phase 2 per-line attribution deferral (Req 21.2), not missing data
 * of unknown cause. v1 reads the outermost scopes only, and a nested
 * invocation's `consumed N of M compute units` line is genuinely present in the
 * log stream — `tests/golden/02-anchor-user-error` line 12 is one — but placing
 * it on the right nested node requires the full-depth line attribution that
 * Phase 2 adds. Until then the honest report is that no value was attributed,
 * which is exactly what this variant says.
 *
 * The same value as `UNAVAILABLE` by construction, and separately named because
 * the reason differs: this one will change when Phase 2 lands, and the absent
 * total will not.
 */
const NESTED_DEFERRED: ComputeUnits = UNAVAILABLE;

// ---------------------------------------------------------------------------
// The scope-count check
// ---------------------------------------------------------------------------

/**
 * Depth of an outermost invocation scope in `LogScope`.
 *
 * **`walkLogScopes` reports `depth` as the `invoke [n]` marker spelled it, so a
 * top-level invocation is `1`, not `0`.** That is the opposite convention from
 * `InstructionNode.depth`, where top-level is `0`, and the two meet in this
 * module: the k-th `depth === 1` scope pairs with the k-th `depth === 0` node.
 * Verified against `LogScope` and the `OPEN_MARKER` regex in `resolve/logs.ts`,
 * which rejects any depth below 1 outright.
 */
const OUTERMOST_SCOPE_DEPTH = 1;

/** The outermost scopes, in log order — `walkLogScopes` returns them sorted. */
function outermost(scopes: readonly LogScope[]): readonly LogScope[] {
  return scopes.filter((scope) => scope.depth === OUTERMOST_SCOPE_DEPTH);
}

/**
 * Decide whether a positional pairing is sound, and against what expectation.
 *
 * The checks run in order of how little they assume. Log absence and truncation
 * are statements about the response's completeness, so they settle the question
 * before the marker sequence is read at all. An unbalanced sequence is checked
 * at *every* depth, not only the outermost: an unclosed nested scope swallows
 * the lines that follow it, including its caller's consumed line, so the
 * sequence being broken anywhere is grounds to stop rather than to pair around
 * the break.
 */
function checkAlignment(
  present: boolean,
  truncated: boolean,
  scopes: readonly LogScope[],
  topLevelCount: number,
  failure: FailureLocation | null,
): ComputeAlignment {
  const scopeCount = outermost(scopes).length;

  if (!present) {
    return { kind: 'degraded', reason: 'logs-absent', scopeCount, expectedScopeCount: null };
  }
  if (truncated) {
    return { kind: 'degraded', reason: 'logs-truncated', scopeCount, expectedScopeCount: null };
  }
  if (scopes.some((scope) => scope.closeIndex === null)) {
    return { kind: 'degraded', reason: 'unbalanced-scopes', scopeCount, expectedScopeCount: null };
  }

  const expectation = expectedScopeCount(topLevelCount, failure);
  if (expectation.kind === 'unknown') {
    return {
      kind: 'degraded',
      reason: expectation.reason,
      scopeCount,
      expectedScopeCount: null,
    };
  }

  if (scopeCount !== expectation.count) {
    return {
      kind: 'degraded',
      reason: 'scope-count-mismatch',
      scopeCount,
      expectedScopeCount: expectation.count,
    };
  }

  return {
    kind: 'aligned',
    scopeCount,
    expectedScopeCount: expectation.count,
    executedCount: expectation.count,
  };
}

type Expectation =
  | { readonly kind: 'known'; readonly count: number }
  | { readonly kind: 'unknown'; readonly reason: ComputeDegradeReason };

/**
 * How many outermost scopes the response says there should be.
 *
 * See the module comment for why this is an expectation rather than the flat
 * equality design.md specifies. The failed-transaction case is the deviation;
 * the successful case is design.md's rule unchanged.
 *
 * A failure that names no index is `unknown` rather than defaulting to the
 * instruction count. Where execution stopped is precisely what such a payload
 * does not say — `"AlreadyProcessed"` and `{ DuplicateInstruction: 3 }` are both
 * real error variants that carry no instruction index — so any count would be
 * assumed rather than observed, and a wrong assumption here pairs values onto
 * instructions that may never have run.
 */
function expectedScopeCount(
  topLevelCount: number,
  failure: FailureLocation | null,
): Expectation {
  if (failure === null) return { kind: 'known', count: topLevelCount };

  const index = failure.failingInstructionIndex;
  if (index === null) return { kind: 'unknown', reason: 'failing-index-absent' };

  // `indexOutOfRange` is consulted as well as re-derived. The flag is
  // `locateFailure`'s conclusion and the bounds test is this module's; they
  // agree on every well-formed response, and disagreement is itself grounds to
  // decline to pair.
  if (failure.indexOutOfRange) {
    return { kind: 'unknown', reason: 'failing-index-out-of-range' };
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= topLevelCount) {
    return { kind: 'unknown', reason: 'failing-index-out-of-range' };
  }

  return { kind: 'known', count: index + 1 };
}

// ---------------------------------------------------------------------------
// Pairing and reading the consumed line
// ---------------------------------------------------------------------------

interface Attribution {
  /** Keyed by node `order`, top-level nodes only. */
  readonly units: ReadonlyMap<number, ComputeUnits>;
  readonly unattributed: readonly UnattributedCompute[];
}

/**
 * Pair each top-level node with its scope, or record why it has no value.
 *
 * On a degraded alignment every node is `available: false` with
 * `alignment-unknown`, without any scope being read — the point of the check is
 * that no positional guess is taken, so the scopes are not consulted at all
 * rather than consulted and discarded.
 */
function attribute(
  topLevel: readonly InstructionNode[],
  scopes: readonly LogScope[],
  messages: readonly string[],
  alignment: ComputeAlignment,
): Attribution {
  const units = new Map<number, ComputeUnits>();
  const unattributed: UnattributedCompute[] = [];

  topLevel.forEach((node, position) => {
    const reason = pair(node, position, scopes, messages, alignment, units);
    if (reason !== null) {
      units.set(node.order, UNAVAILABLE);
      unattributed.push({ order: node.order, reason });
    }
  });

  return { units, unattributed };
}

/**
 * Assign one node's value, returning the reason when there is none.
 *
 * `null` means a value was set. The caller records the `available: false`
 * variant for every other outcome, so the two branches cannot disagree about
 * what an unattributed node looks like.
 */
function pair(
  node: InstructionNode,
  position: number,
  scopes: readonly LogScope[],
  messages: readonly string[],
  alignment: ComputeAlignment,
  units: Map<number, ComputeUnits>,
): UnattributedComputeReason | null {
  if (alignment.kind === 'degraded') return 'alignment-unknown';

  // The truncated tail. Positions at or past the executed count belong to
  // instructions the runtime never reached, which is why they emitted no scope.
  if (position >= alignment.executedCount) return 'never-executed';

  const scope = scopes[position];
  if (scope === undefined) return 'never-executed';

  const value = readConsumedUnits(scope, messages);
  if (value === null) return 'no-compute-line';

  units.set(node.order, { available: true, value, confidence: 'full' });
  return null;
}

/**
 * `Program <id> consumed N of M compute units`, whole-line.
 *
 * `N` is the units the invocation spent and `M` is the budget it was given; only
 * `N` is read. The program id must be base58-shaped and of address length, the
 * same cheap discriminator `resolve/logs.ts` applies to its markers, because
 * programs do write arbitrary text into this stream.
 */
const CONSUMED_LINE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) consumed (\d+) of (\d+) compute units$/;

/**
 * The units a scope consumed, or `null` when it reported none.
 *
 * Only the scope's own `lineIndices` are searched, so a nested invocation's
 * consumed line cannot be mistaken for its caller's — `walkLogScopes` assigns
 * each line index to exactly one scope, and that exclusivity is what makes this
 * read correct rather than merely plausible.
 *
 * Two narrowings guard against a program forging the line, since `Program log:`
 * content is program-controlled and lands in the same array:
 *
 * - The line must name the scope's own program. A consumed line attributed to a
 *   different id is not this invocation's accounting.
 * - The **last** qualifying line wins. The runtime emits its accounting once,
 *   immediately before the terminating marker, and "last before the close" is
 *   how design.md words it — note that the runtime's line is not always
 *   *adjacent* to the marker, since `Program return:` data can sit between them
 *   (`tests/golden/02-anchor-user-error`, lines 18-20). A program writing a
 *   look-alike line earlier in its own output therefore cannot displace it.
 *
 * `closeIndex === null` is unreachable here — an unbalanced sequence degrades
 * the whole transaction before any scope is read — and is rejected anyway rather
 * than trusted, because a scope with no terminating marker has no "line before
 * the marker" to speak of.
 */
function readConsumedUnits(scope: LogScope, messages: readonly string[]): number | null {
  if (scope.closeIndex === null) return null;

  for (let position = scope.lineIndices.length - 1; position >= 0; position -= 1) {
    const index = scope.lineIndices[position];
    if (index === undefined) continue;
    if (index > scope.closeIndex) continue;

    const line = messages[index];
    if (line === undefined) continue;

    const match = CONSUMED_LINE.exec(line);
    if (match === null) continue;
    if (match[1] !== scope.programId) continue;

    const consumed = match[2];
    if (consumed === undefined) continue;

    const value = Number.parseInt(consumed, 10);
    // A value too large to represent exactly is not a value. Compute units are
    // capped far below this in practice, so the branch is a guarantee about the
    // output rather than an expected input.
    if (!Number.isSafeInteger(value) || value < 0) continue;

    return value;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Writing the tree
// ---------------------------------------------------------------------------

/**
 * Set `computeUnits` on every node at every depth.
 *
 * Assignment, never a conditional update: a top-level node takes its paired
 * value or the `available: false` variant, and every nested node takes
 * `NESTED_DEFERRED`. So whatever the tree builder's placeholder left behind is
 * overwritten, and the v1 rule that no nested node carries a value holds by
 * construction rather than by the placeholder happening to already be right.
 *
 * `order` is the key rather than position or object identity, because it is
 * unique across the whole transaction at every depth (Req 3.4).
 *
 * Reuses `mapInstructionTree` rather than recursing. The walk is iterative so an
 * unbounded CPI chain (Req 3.6) cannot exhaust the stack, and a second copy of
 * it here would be a copy that drifts.
 */
function assign(
  tree: readonly InstructionNode[],
  units: ReadonlyMap<number, ComputeUnits>,
): readonly InstructionNode[] {
  return mapInstructionTree(tree, (node, inner) => ({
    ...node,
    computeUnits: node.depth === 0 ? (units.get(node.order) ?? UNAVAILABLE) : NESTED_DEFERRED,
    inner,
  }));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Whether an untrusted value is a compute unit count.
 *
 * `Number.isSafeInteger` rejects `NaN`, infinities, and non-integers; the sign
 * test rejects a negative count, which Requirement 8.1 excludes by calling the
 * value a non-negative integer.
 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
