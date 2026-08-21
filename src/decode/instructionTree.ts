/**
 * Instruction tree builder.
 *
 * Satisfies Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 3.8.
 *
 * Merges `message.instructions` with `meta.innerInstructions` into a recursive
 * tree. The RPC delivers CPI frames as a flat list per top-level index, each
 * carrying a `stackHeight`; parentage is reconstructed from that by attaching
 * every inner instruction to the most recent still-open node one level above it.
 *
 * Four properties carry this module:
 *
 * - **No depth limit and no depth-based abort** (Req 3.6). Whatever depth the
 *   runtime executed is what gets built. Nothing here counts levels, compares
 *   against a threshold, throws, or truncates. Recursion is structural only —
 *   the traversal itself is iterative, so a pathologically deep CPI chain
 *   cannot exhaust the stack during construction either.
 * - **`order` is one global counter** in transaction appearance order across all
 *   depths (Req 3.4), so a subtree occupies a contiguous run of orders: a
 *   top-level node, then everything it invoked, then the next top-level node.
 *   `depth` and `parentOrder` are recorded per node (Req 3.3), and because an
 *   inner frame is always numbered after its parent, `parentOrder` never points
 *   forward.
 * - **An unresolvable program ID is not a decode failure** (Req 3.7 vs 3.5).
 *   The node is recorded as successfully decoded with `valid: false` and a
 *   reason naming the unresolved index. Undecodable instruction *data* is the
 *   decoder registry's concern and leaves `valid` true — the instruction is
 *   real, only its payload was unreadable. A program ID that resolves through
 *   `loadedAddresses` is as valid as a static one (Req 3.8), which follows for
 *   free from resolving against the effective key list rather than the static
 *   keys.
 * - **Every account index goes through `resolveAccountRef`**, the single point
 *   of index resolution, which cannot read out of bounds. No index is used to
 *   subscript anything in this file.
 *
 * Fields other tasks own are populated with placeholders here; see
 * `PLACEHOLDERS` below for exactly which and why.
 */

import type {
  AccountRef,
  Base58Address,
  ComputeUnits,
  Confidence,
  InstructionDecode,
  InstructionNode,
} from '../model/analysis.js';
import type { RawInnerInstructionGroup, RawInstruction, RawTransactionResponse } from '../model/rawResponse.js';
import { resolveAccountRef, type EffectiveKeys } from './accountKeys.js';
import { programNameFor } from './programNames.js';

/**
 * `stackHeight` of a top-level instruction as the RPC reports it. All six
 * recorded fixtures carry `stackHeight: 1` on every top-level instruction and
 * `2` on its direct callees, so an inner frame at height `h` has depth `h - 1`.
 */
const TOP_LEVEL_STACK_HEIGHT = 1;

/**
 * Build the instruction tree for one transaction response.
 *
 * Returns the top-level nodes in message order; nested frames hang off `inner`.
 */
export function buildInstructionTree(
  response: RawTransactionResponse,
  keys: EffectiveKeys,
): readonly InstructionNode[] {
  const topLevel = response.transaction.message.instructions;
  const innerByIndex = groupInnerInstructions(response.meta?.innerInstructions ?? null);
  const counter: OrderCounter = { next: 0 };
  const roots: InstructionNode[] = [];

  for (const [index, instruction] of topLevel.entries()) {
    // Req 3.1: one record per top-level instruction, in appearance order.
    const top = createNode(instruction, keys, counter, 0, null, 'full');
    roots.push(top.node);

    // Req 3.2, 3.4: the frames this instruction invoked are numbered
    // immediately after it, before the next top-level instruction.
    const inner = innerByIndex.get(index);
    if (inner !== undefined && inner.length > 0) {
      attachInnerInstructions(inner, top, keys, counter);
    }
  }

  return roots;
}

// ---------------------------------------------------------------------------
// Parentage reconstruction
// ---------------------------------------------------------------------------

/**
 * Attach one top-level instruction's recorded CPI frames beneath it.
 *
 * Two modes, and which one applies is decided per group rather than per frame:
 *
 * - **Reconstructed** — every frame carries a usable `stackHeight`, so each one
 *   attaches to the most recent open node at `stackHeight - 1` and the real
 *   nesting is recovered at `full` confidence.
 * - **Flat** — at least one frame is missing a usable `stackHeight`, as older
 *   nodes deliver. Nesting is then not recoverable for the group at all, since a
 *   frame with no height cannot be placed and every frame after it would inherit
 *   the guess. All frames for the index become direct children of the top-level
 *   instruction and are marked `partial`, which is the design's stated fallback:
 *   a shallower tree that is honest about being shallower.
 */
function attachInnerInstructions(
  instructions: readonly RawInstruction[],
  top: OpenNode,
  keys: EffectiveKeys,
  counter: OrderCounter,
): void {
  if (!instructions.every(hasUsableStackHeight)) {
    for (const instruction of instructions) {
      const child = createNode(instruction, keys, counter, top.node.depth + 1, top.node.order, 'partial');
      top.children.push(child.node);
    }
    return;
  }

  // Most recent still-open node at each stack height. Sparse and unbounded in
  // length: the array grows to whatever depth the runtime reached (Req 3.6).
  const openAtHeight: (OpenNode | undefined)[] = [];
  openAtHeight[TOP_LEVEL_STACK_HEIGHT] = top;

  for (const instruction of instructions) {
    const height = instruction.stackHeight;
    const direct = openAtHeight[height - 1];
    // A gap in the height sequence (say 2 followed by 4) means the frame that
    // would have been its parent was never recorded. Rather than drop the frame
    // or invent a level, attach it to the nearest enclosing open node and mark
    // the node `partial`, since its depth is then a lower bound on the truth.
    const parent = direct ?? nearestOpenBelow(openAtHeight, height);
    const confidence: Confidence = direct === undefined ? 'partial' : 'full';

    const child = createNode(
      instruction,
      keys,
      counter,
      parent.node.depth + 1,
      parent.node.order,
      confidence,
    );
    parent.children.push(child.node);

    // This frame closes every scope deeper than itself: a later frame at
    // greater height belongs under this node, never under a sibling's callee.
    openAtHeight.length = Math.min(openAtHeight.length, height);
    openAtHeight[height] = child;
  }
}

/**
 * Group inner instructions by the top-level index that invoked them.
 *
 * Two input quirks are absorbed here. Groups are keyed rather than indexed, so
 * they need not arrive sorted by `index`. Repeated indices accumulate in
 * encounter order instead of the later group replacing the earlier one, because
 * dropping recorded frames would silently shrink the tree.
 *
 * A group naming an index with no matching top-level instruction is not
 * reachable through the lookup and is therefore left out: a CPI frame is defined
 * by Req 3.2 as nested within a top-level instruction, and `InstructionNode`
 * has no spelling for a frame whose parent does not exist.
 */
function groupInnerInstructions(
  groups: readonly RawInnerInstructionGroup[] | null,
): ReadonlyMap<number, readonly RawInstruction[]> {
  const byIndex = new Map<number, RawInstruction[]>();
  if (groups === null) return byIndex;

  for (const group of groups) {
    const existing = byIndex.get(group.index);
    if (existing === undefined) {
      byIndex.set(group.index, [...group.instructions]);
    } else {
      existing.push(...group.instructions);
    }
  }
  return byIndex;
}

/**
 * Nearest open node strictly below `height`. The top-level node is always
 * registered at `TOP_LEVEL_STACK_HEIGHT`, so this always finds one.
 */
function nearestOpenBelow(openAtHeight: readonly (OpenNode | undefined)[], height: number): OpenNode {
  for (let h = height - 1; h > TOP_LEVEL_STACK_HEIGHT; h -= 1) {
    const candidate = openAtHeight[h];
    if (candidate !== undefined) return candidate;
  }
  const top = openAtHeight[TOP_LEVEL_STACK_HEIGHT];
  /* c8 ignore next */
  if (top === undefined) throw new Error('internal: top-level scope missing from open node table');
  return top;
}

/**
 * Whether a frame's `stackHeight` can carry parentage: present, a safe integer,
 * and deeper than a top-level instruction. Anything else — absent, `null`, a
 * float, or a height at or above the top level — is a group-wide fall back to
 * flat parentage.
 */
function hasUsableStackHeight(
  instruction: RawInstruction,
): instruction is RawInstruction & { readonly stackHeight: number } {
  const height = instruction.stackHeight;
  return (
    typeof height === 'number' &&
    Number.isSafeInteger(height) &&
    height > TOP_LEVEL_STACK_HEIGHT
  );
}

// ---------------------------------------------------------------------------
// Node construction
// ---------------------------------------------------------------------------

/**
 * A node plus a live handle on its child array.
 *
 * `InstructionNode.inner` is `readonly`, and the array assigned to it is the
 * same object as `children` — so children can be appended after the parent
 * object exists without a cast and without rebuilding the tree bottom-up.
 * Nothing outside this module receives the mutable handle.
 */
interface OpenNode {
  readonly node: InstructionNode;
  readonly children: InstructionNode[];
}

interface OrderCounter {
  next: number;
}

function createNode(
  instruction: RawInstruction,
  keys: EffectiveKeys,
  counter: OrderCounter,
  depth: number,
  parentOrder: number | null,
  confidence: Confidence,
): OpenNode {
  const order = counter.next;
  counter.next += 1;

  const program = resolveProgram(instruction.programIdIndex, keys);
  const children: InstructionNode[] = [];

  const node: InstructionNode = {
    order,
    depth,
    parentOrder,
    programId: program.programId,
    // Display labelling only, and inert: nothing in decoder selection, error
    // namespace selection, or confidence reads this field, which is what makes
    // setting it here — before the registry runs — harmless. See the header of
    // `programNames.ts`. `null` for any program not in that table, and for an
    // unresolved program ID, which has no address to look up.
    programName: programNameFor(program.programId),
    decode: pendingDecode(),
    // Req 3.1, 3.2: account indices, resolved through the single point of index
    // resolution so an out-of-range index becomes an `unresolved` ref.
    accounts: instruction.accounts.map((index): AccountRef => resolveAccountRef(keys, index)),
    failed: false,
    valid: program.valid,
    invalidReason: program.invalidReason,
    computeUnits: PENDING_COMPUTE_UNITS,
    logs: [],
    inner: children,
    confidence,
  };

  return { node, children };
}

/**
 * Resolve an instruction's program ID against the effective account key list.
 *
 * Req 3.7: an index that resolves to neither a static key nor a loaded address
 * yields `valid: false` and a reason naming it, while the node itself still
 * counts as successfully decoded. Req 3.8: resolution through `loadedAddresses`
 * is ordinary resolution, so `valid` is true — which is automatic here, since
 * the lookup runs against the effective list rather than the static keys.
 */
function resolveProgram(
  programIdIndex: number,
  keys: EffectiveKeys,
): {
  readonly programId: Base58Address | null;
  readonly valid: boolean;
  readonly invalidReason: string | null;
} {
  const ref = resolveAccountRef(keys, programIdIndex);
  if (ref.kind === 'resolved') {
    return { programId: ref.address, valid: true, invalidReason: null };
  }
  return {
    programId: null,
    valid: false,
    invalidReason:
      `program ID at account index ${programIdIndex} could not be resolved: ${ref.reason}`,
  };
}

// ---------------------------------------------------------------------------
// PLACEHOLDERS — fields this task does not own
// ---------------------------------------------------------------------------

/**
 * `decode` belongs to the decoder registry, which does not exist yet. Until it
 * does, every node carries the `raw`/`Unknown` variant: it is the variant that
 * claims the least, and it is what the registry will produce anyway for a
 * program with no decoder and no IDL.
 *
 * `rawInstructionData` is deliberately empty rather than a hand-rolled encoding
 * of `instruction.data`. Base58 decoding, hex encoding, the 256-byte truncation
 * rule, and the true `byteLength` are one cohesive piece of behaviour owned by
 * the registry, and a second implementation here would be a copy that drifts.
 * The registry replaces this whole value per node, so no field of it survives
 * into an `Analysis`.
 */
function pendingDecode(): InstructionDecode {
  return {
    kind: 'raw',
    name: 'Unknown',
    note: 'Unknown program',
    rawInstructionData: {
      label: 'raw_instruction_data',
      hex: '0x',
      byteLength: 0,
      truncated: false,
    },
    errorDetail: 'instruction data not yet decoded: the decoder registry is not wired in',
    confidence: 'raw',
  };
}

/**
 * `computeUnits` is attributed from the depth-1 log scopes by the compute
 * analyzer. `available: false` is the correct value before that runs — it is
 * also the final value on every nested node in v1 — and it is the only variant
 * that does not require inventing a number.
 */
const PENDING_COMPUTE_UNITS: ComputeUnits = { available: false, confidence: 'raw' };
