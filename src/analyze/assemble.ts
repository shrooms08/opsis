/**
 * Analysis assembly — the last stage before the boundary.
 *
 * Satisfies Requirement 9, and Requirements 11.2/11.4 in aggregate.
 *
 * Every stage above this one produces a *part*: an effective key list, an
 * instruction tree, a log report, balances, compute. This module turns those
 * parts into the single `Analysis` object and owns the three guarantees no
 * upstream module can own alone, because each is a property of the whole:
 *
 * 1. **Ordering.** Every collection is sorted by its declared key (Req 9.1,
 *    9.6). A stage that produces one collection cannot guarantee the ordering of
 *    the object it lands in, and a stage that reads a file system directory
 *    cannot guarantee its own ordering at all.
 * 2. **Shape.** No `Map`, no `Date`, no class instance, no float reaches
 *    `Analysis` (Req 9.2). Maps that exist inside a producing module are
 *    flattened into arrays here.
 * 3. **Confidence propagation.** Containers get their aggregate marker here and
 *    nowhere else (Req 11.2, 11.4), so a component author sets only their own
 *    node's intrinsic marker and *cannot* forget the aggregation step — it is
 *    not theirs to perform.
 *
 * Three absences are as load-bearing as the contents:
 *
 * - **No provenance.** Nothing in `Analysis` records whether the response came
 *   from a fixture file or from a live RPC call, because Requirement 10.5
 *   demands identical output from both and design.md's Property 6 rests on it.
 *   `AnalysisInput` has no field for it, so it cannot be added by accident.
 * - **No clock, no process, no duration** (Req 9.5).
 * - **No locale-sensitive formatting anywhere.** String comparison uses `<`,
 *   which compares UTF-16 code units, never `localeCompare`, whose result
 *   depends on `LANG`/`LC_ALL` and would silently reorder `tokenBalances`
 *   between two machines (Req 9.7). No `Date`, no `toLocaleString`, no
 *   `Intl`. Nothing here formats a number at all — numeric presentation is the
 *   renderer's job and lamport values are already decimal strings.
 *
 * This function is pure and total: it reads only its argument, mutates nothing
 * it was given, and has no failure mode.
 */

import type {
  AccountEntry,
  Analysis,
  Base58Signature,
  ComputeReport,
  Confidence,
  FailureReport,
  InstructionNode,
  LamportBalanceChange,
  LogReport,
  MessageVersion,
  TokenBalanceChange,
  TransactionOutcome,
} from '../model/analysis.js';
import { minConfidence } from '../model/confidence.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * The parts of an `Analysis`, before assembly.
 *
 * Field-for-field the same shape as `Analysis`, and that is deliberate rather
 * than lazy: the difference is not in the *types* but in the two guarantees the
 * input is not yet required to meet. Collections may arrive in any order, and
 * every container's `confidence` is its **intrinsic** marker — what the
 * producing stage concluded about its own layer, with nothing folded in from
 * below. `assembleAnalysis` establishes both.
 *
 * Declaring the input structurally identical to the output means a new field on
 * `Analysis` is a compile error here until it is threaded through, rather than
 * an unsorted collection that ships.
 */
export interface AnalysisInput {
  readonly signature: Base58Signature;
  readonly messageVersion: MessageVersion;
  readonly outcome: TransactionOutcome;
  /** Any order; sorted by `index` on the way out. */
  readonly accountKeys: readonly AccountEntry[];
  /** Top-level nodes in any order, with intrinsic confidence markers. */
  readonly instructions: readonly InstructionNode[];
  readonly failure: FailureReport | null;
  /** Any order; sorted by `accountIndex` on the way out. */
  readonly lamportBalances: readonly LamportBalanceChange[];
  /** Any order; sorted by `(accountIndex, mint)` on the way out. */
  readonly tokenBalances: readonly TokenBalanceChange[];
  readonly compute: ComputeReport;
  /** Intrinsic container confidence; the attribution fold happens here. */
  readonly logs: LogReport;
}

/**
 * Assemble the final `Analysis`.
 *
 * Sorts every collection, rewrites every container's confidence bottom-up, and
 * copies every array so no caller retains a mutable handle on anything inside
 * the returned object.
 */
export function assembleAnalysis(input: AnalysisInput): Analysis {
  // Bottom-up over the tree, before the log fold, because the attributed-log
  // markers the log report folds are collected during that same walk.
  const attributedLogMarkers: Confidence[] = [];
  const instructions = sortByOrder(
    mapInstructionTree(input.instructions, (node, inner) =>
      closeNode(node, sortByOrder(inner), attributedLogMarkers),
    ),
  );

  return {
    signature: input.signature,
    messageVersion: input.messageVersion,
    outcome: input.outcome,
    accountKeys: sortAccountKeys(input.accountKeys),
    instructions,
    failure: input.failure,
    lamportBalances: sortLamportBalances(input.lamportBalances),
    tokenBalances: sortTokenBalances(input.tokenBalances),
    compute: input.compute,
    logs: foldLogReport(input.logs, attributedLogMarkers),
  };
}

// ---------------------------------------------------------------------------
// Confidence propagation — Requirements 11.2, 11.4
// ---------------------------------------------------------------------------

/**
 * A child's contribution to its container's marker, floored at `partial`.
 *
 * This is the asymmetry design.md states explicitly, and it is the one place it
 * is implemented: **a container with a `raw` child is capped at `partial`, not
 * dropped to `raw`**, because the container genuinely decoded its own layer —
 * the program was identified, the accounts resolved — and reporting the whole
 * node as wholly unread would understate what is known, which is its own kind
 * of dishonesty.
 *
 * Nothing is upgraded by this. The child keeps its own `raw` marker in the
 * output, unchanged and visible; only its pull on the parent is bounded. And
 * because the fold still starts from the container's own intrinsic marker, a
 * container that is itself `raw` stays `raw` no matter what it contains.
 */
function childContribution(confidence: Confidence): Confidence {
  return confidence === 'raw' ? 'partial' : confidence;
}

/** Fold a container's own marker with its children's, floored per above. */
function aggregate(own: Confidence, children: readonly Confidence[]): Confidence {
  return minConfidence(own, children.map(childContribution));
}

/**
 * Rewrite one node once every child of it has been rewritten.
 *
 * An instruction node folds exactly three things, per design.md: its decode, its
 * account references, and its nested instructions. Two fields are deliberately
 * *not* in the fold:
 *
 * - `computeUnits`, which is `available: false` at `raw` confidence on every
 *   nested node in v1 by deferral rather than by any decode failure. Folding it
 *   would cap essentially every instruction in every transaction at `partial`
 *   and the marker would stop meaning anything.
 * - `logs`, whose entries are pinned to `partial` because marker-based
 *   attribution is never better than that (Req 21.3). Folding them would cap
 *   every node that emitted a log line, for a reason that says nothing about how
 *   well the instruction itself was read. Those markers go to the log report,
 *   which is the container that owns them — collected here, folded there.
 */
function closeNode(
  node: InstructionNode,
  inner: readonly InstructionNode[],
  attributedLogMarkers: Confidence[],
): InstructionNode {
  const markers: Confidence[] = [node.decode.confidence];
  for (const account of node.accounts) markers.push(account.confidence);
  for (const child of inner) markers.push(child.confidence);
  for (const log of node.logs) attributedLogMarkers.push(log.confidence);

  return {
    ...node,
    // Copied so the assembled tree shares no array with the input tree.
    accounts: [...node.accounts],
    logs: [...node.logs],
    inner,
    confidence: aggregate(node.confidence, markers),
  };
}

// ---------------------------------------------------------------------------
// Stack-safe tree rewriting
// ---------------------------------------------------------------------------

/**
 * Rebuild an instruction tree bottom-up, calling `rewrite` on each node after
 * every one of its children has been rewritten.
 *
 * **Iterative, not recursive, and that is a guarantee rather than a style
 * choice.** `inner` is unbounded (Req 3.6) and the tree builder is careful never
 * to recurse over it so a pathologically deep CPI chain cannot exhaust the stack
 * during construction. Undoing that one stage later would leave the tool unable
 * to report the very tree it just built. Each frame below accumulates its
 * rewritten children in `output` and, once its cursor is exhausted, pushes its
 * own rewritten self into its parent's accumulator.
 *
 * **Exported because two stages rewrite this tree**: assembly folds confidence,
 * and the pipeline substitutes each node's decode. A second copy of this walk in
 * `pipeline.ts` would be a copy that drifts, and the failure mode of drift here
 * is a silently mis-shaped tree. `rewrite` receives children in their existing
 * `inner` order; ordering is this module's concern and is applied by the
 * callback, not by the walker.
 */
export function mapInstructionTree(
  roots: readonly InstructionNode[],
  rewrite: (node: InstructionNode, inner: readonly InstructionNode[]) => InstructionNode,
): readonly InstructionNode[] {
  return roots.map((root) => rewriteSubtree(root, rewrite));
}

/** One node mid-traversal: its children, its results, and its parent's sink. */
interface Frame {
  readonly node: InstructionNode;
  /** Rewritten children, accumulating. Becomes this node's `inner`. */
  readonly output: InstructionNode[];
  /** The parent's accumulator, where this node's rewritten self lands. */
  readonly sink: InstructionNode[];
  cursor: number;
}

function rewriteSubtree(
  root: InstructionNode,
  rewrite: (node: InstructionNode, inner: readonly InstructionNode[]) => InstructionNode,
): InstructionNode {
  const sink: InstructionNode[] = [];
  const stack: Frame[] = [{ node: root, output: [], sink, cursor: 0 }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    /* c8 ignore next */
    if (frame === undefined) break;

    const child = frame.node.inner[frame.cursor];
    if (child !== undefined) {
      frame.cursor += 1;
      // Depth-first, one child at a time: the child frame runs to completion
      // before this frame is looked at again, so `output` fills in child order.
      stack.push({ node: child, output: [], sink: frame.output, cursor: 0 });
      continue;
    }

    stack.pop();
    frame.sink.push(rewrite(frame.node, frame.output));
  }

  const rewritten = sink[0];
  /* c8 ignore next */
  if (rewritten === undefined) throw new Error('internal: post-order walk produced no root node');
  return rewritten;
}

/**
 * Fold the log report over every attributed log marker in the transaction.
 *
 * In v1 the marker list is empty on every node, so the container confidence is
 * exactly what `captureLogs` determined from presence and truncation — `full`,
 * `partial`, or `raw`. The fold is written anyway rather than skipped: when
 * Phase 2 populates `InstructionNode.logs`, propagation lands without touching
 * this module, which is the whole point of propagation living in one place.
 */
function foldLogReport(logs: LogReport, attributedLogMarkers: readonly Confidence[]): LogReport {
  return {
    // Verbatim and unsorted, both of them: `messages` is the RPC array in RPC
    // order (Req 21.1), and sorting it would destroy the only thing it claims.
    messages: [...logs.messages],
    present: logs.present,
    truncated: logs.truncated,
    unattributed: [...logs.unattributed],
    confidence: aggregate(logs.confidence, attributedLogMarkers),
  };
}

// ---------------------------------------------------------------------------
// Ordering — Requirements 9.1, 9.6
// ---------------------------------------------------------------------------

/**
 * Instruction nodes ascending by `order` (Req 3.4).
 *
 * Applied to the top level and to every `inner` array. `order` is a global
 * counter unique across the whole transaction, so the comparator is total and
 * the sort needs no tiebreak.
 */
function sortByOrder(nodes: readonly InstructionNode[]): readonly InstructionNode[] {
  return [...nodes].sort((a, b) => a.order - b.order);
}

/** Account entries ascending by `index` (Req 19.2, 19.3). */
function sortAccountKeys(entries: readonly AccountEntry[]): readonly AccountEntry[] {
  return [...entries]
    .sort((a, b) => a.index - b.index)
    .map((entry) => ({
      ...entry,
      // Declared ascending (Req 7.11). Populating it belongs to the balance
      // stage; ordering it belongs here, like every other collection.
      referencedBy: [...entry.referencedBy].sort((a, b) => a - b),
    }));
}

/** Lamport balance changes ascending by `accountIndex` (Req 7.8, 7.9). */
function sortLamportBalances(
  balances: readonly LamportBalanceChange[],
): readonly LamportBalanceChange[] {
  return [...balances].sort((a, b) => a.accountIndex - b.accountIndex);
}

/**
 * Token balance changes ascending by `(accountIndex, mint)` (Req 20).
 *
 * One account can hold balances in several mints, so `accountIndex` alone is not
 * a key and a sort on it alone would leave the relative order of two mints on
 * one account up to the engine's sort stability and the input order. `mint`
 * breaks the tie by code unit, not by locale (Req 9.7).
 */
function sortTokenBalances(
  balances: readonly TokenBalanceChange[],
): readonly TokenBalanceChange[] {
  return [...balances].sort(
    (a, b) => a.accountIndex - b.accountIndex || compareCodeUnits(a.mint, b.mint),
  );
}

/**
 * Compare two strings by UTF-16 code unit.
 *
 * `localeCompare` is the wrong tool and the difference is not academic: it
 * orders by the active collation, so the same two mint addresses can sort
 * differently under two values of `LC_ALL`, and the tool would emit two
 * different `Analysis` objects for one input (Req 9.7). `<` and `>` are defined
 * on code units and depend on nothing outside the strings.
 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
