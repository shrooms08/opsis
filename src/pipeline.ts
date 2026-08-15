/**
 * The pipeline — one pure function from a recorded or fetched response to an
 * `Analysis`.
 *
 * **This module is not named in design.md, and its existence is deliberate
 * rather than an oversight.** design.md draws the chain
 * decode → resolve → analyze → assemble as a graph of pure functions but names
 * no composer for it, which leaves every caller to compose the stages itself.
 * Two callers need exactly that chain: the golden harness (task 4.10), which
 * drives the real pipeline from `input.json`, and the CLI (task 11.5). Two
 * hand-rolled compositions would be two chances to wire the stages differently,
 * and a golden suite that exercised a different composition from the one users
 * run would be worse than no golden suite at all. So there is one entry point,
 * and the harness and the CLI both call it.
 *
 * What this module is *not*: it performs no I/O of any kind. No argv, no
 * environment, no file system, no network, no stdout, no clock. It takes a
 * response object and returns a value. That is what lets the golden harness
 * substitute a fixture for a live response at the outermost seam only
 * (`TransactionSource`) and run every module below it unmocked, and it is what
 * makes Requirement 10.5 — identical output from a fixture and from the network —
 * true by construction rather than by inspection: nothing here can tell which it
 * was handed, and `Analysis` has no field in which to record it.
 *
 * ## Wiring status
 *
 * Every stage design.md names is wired. Nothing in this file is a placeholder
 * any more: the decoder registry's full precedence ladder, failure location,
 * error resolution, compute attribution, lamport balances, token balances, and
 * log capture all run, and their outputs go to `assembleAnalysis` unmodified.
 *
 * Two deliberate gaps remain, and neither is this module's to fill. Per-line log
 * attribution (Req 21.2-21.4) and CPI failure attribution (Req 5.5) are Phase 2:
 * `AttributedLog` has no producer and `FailureReport.cpiAttribution` is
 * unconditionally `null`, decided in `resolve/failure.ts` rather than here.
 *
 * ## Stage order, and what forces it
 *
 * `decode → locateFailure → analyzeCompute → balances → assemble`, and three of
 * those four arrows are load-bearing:
 *
 * - `locateFailure` needs the decoded tree, and `analyzeCompute` needs
 *   `located.failure` — its scope-to-instruction pairing counts the instructions
 *   the runtime actually reached, which on a failure is `failingIndex + 1`.
 * - `analyzeCompute` **rewrites the tree**, assigning `computeUnits` at every
 *   depth. Its output is therefore the tree that must reach `assembleAnalysis`;
 *   passing `located.instructions` there instead would silently drop every
 *   compute value while still typechecking.
 * - `analyzeLamportBalances` only reads the tree, so either would do. It is given
 *   `computed.instructions` — the same array that reaches the output — so the
 *   `referencedBy` lists it derives are provably about the instructions a reader
 *   of the `Analysis` can see, not about an intermediate tree that no longer
 *   exists.
 */

import { assembleAnalysis, mapInstructionTree } from './analyze/assemble.js';
import { analyzeLamportBalances } from './analyze/balances.js';
import { analyzeCompute } from './analyze/compute.js';
import { deriveTokenBalances } from './analyze/tokenBalances.js';
import { resolveAccountKeys } from './decode/accountKeys.js';
import { buildInstructionTree } from './decode/instructionTree.js';
import type { IdlStore } from './decode/idl/idlStore.js';
import { createRegistry, type DecoderRegistry } from './decode/registry.js';
import type {
  AccountRef,
  Analysis,
  Base58Signature,
  InstructionDecode,
  InstructionNode,
} from './model/analysis.js';
import type { RawInstruction, RawTransactionResponse } from './model/rawResponse.js';
import { buildFailureReport } from './resolve/errorResolver.js';
import { locateFailure } from './resolve/failure.js';
import { captureLogs } from './resolve/logs.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface PipelineInput {
  /** The verbatim `getTransaction` result, from a fixture or from a node. */
  readonly response: RawTransactionResponse;
  /**
   * The signature to record in the `Analysis`.
   *
   * Optional because the response already contains it: a caller that has one —
   * the CLI, which has the user's argument — passes it, and a caller that does
   * not — the golden harness, which has only `input.json` — omits it and gets
   * `transaction.signatures[0]`. Both spellings are deterministic, which is what
   * Requirement 9.1 asks of them.
   */
  readonly signature?: Base58Signature;
  /**
   * The Anchor IDL store the decoder registry and the error resolver consult.
   *
   * Optional and nullable, which are the same statement made twice on purpose:
   * `--idl-dir` is an optional flag, so "no store" is an ordinary input rather
   * than a degraded one. A caller that omits the field and a caller that passes
   * `null` are treated identically — with no IDL, decoding falls to the built-in
   * decoders and `resolveError` reports a user-defined code as `no-idl`
   * (Req 6.5), both of which are correct answers and not failures.
   *
   * Threaded to exactly two places: `createRegistry`, for the top rung of the
   * precedence ladder (Req 4.1, 4.6), and `buildFailureReport`, for the `errors`
   * array of the failing program's IDL (Req 6.1).
   */
  readonly idls?: IdlStore | null;
}

/**
 * Analyze one transaction response.
 *
 * Pure and deterministic: same input, same output, byte for byte, under any
 * locale, timezone, or platform (Req 9.1, 9.7).
 */
export function analyzeTransaction(input: PipelineInput): Analysis {
  const response = input.response;
  const idls = input.idls ?? null;

  // decode ---------------------------------------------------------------
  const keys = resolveAccountKeys(response);
  const tree = buildInstructionTree(response, keys);
  const decoded = applyDecodes(response, tree, createRegistry(idls));

  // resolve --------------------------------------------------------------
  const logs = captureLogs(response);
  // Marks the failing top-level node, and forces `failed: false` everywhere on a
  // successful transaction (Req 5.2, 5.3).
  const located = locateFailure(response, decoded);

  // The one read of `meta.err` in this module. `locateFailure` reads it too, and
  // agrees by construction — but `succeeded` below and the guard here are
  // literally the same expression, so a failed transaction cannot report
  // `succeeded: true` while carrying a report, or the reverse.
  const err = response.meta?.err ?? null;
  // Both conditions hold together or neither does: `located.failure` is non-null
  // exactly when `err` is. The pair is spelled out because `buildFailureReport`
  // needs both values non-null and TypeScript will not infer one from the other,
  // and because the alternative — asserting — would put a throw in a pure stage.
  const failure =
    located.failure !== null && err !== null
      ? buildFailureReport(located.failure, err, idls, logs)
      : null;

  // analyze --------------------------------------------------------------
  // `analyzeCompute` captures the logs again internally. Accepted rather than
  // refactored: `captureLogs` is a copy of `meta.logMessages` and two flag reads,
  // the arrays involved are transaction-sized, and threading a `LogReport` into
  // `analyzeCompute` would change a public signature to save a copy nobody can
  // measure. The two calls cannot disagree — `captureLogs` is pure in its
  // argument, and both are handed the same response.
  const computed = analyzeCompute(response, located.instructions, located.failure);
  // `computed.instructions` and not `located.instructions`: see "Stage order" in
  // the module header. `balances.unrepresented` has no field in `Analysis` and is
  // not consumed in v1; it stays available to a later diagnostic rather than
  // being folded into something that would misreport it.
  const balances = analyzeLamportBalances(response, keys, computed.instructions);

  // assemble -------------------------------------------------------------
  return assembleAnalysis({
    signature: input.signature ?? primarySignature(response),
    messageVersion: keys.messageVersion,
    // Requirement 22.1 is `meta.err === null`, and Requirement 6.4 puts the
    // resolved error here as well as on the report. It is the same value, not a
    // second resolution: absent metadata reads as no recorded error rather than
    // as a failure, because a response with no metadata carries no evidence of
    // one and inventing a failure from missing data would be a worse claim.
    outcome: { succeeded: err === null, error: failure?.error ?? null },
    // `balances.accountKeys`, not `keys.entries` — this is the list with
    // `referencedBy` populated (Req 7.11).
    accountKeys: balances.accountKeys,
    instructions: computed.instructions,
    failure,
    lamportBalances: balances.balances,
    tokenBalances: deriveTokenBalances(response, keys),
    compute: computed.compute,
    logs,
  });
}

// ---------------------------------------------------------------------------
// Decode substitution
// ---------------------------------------------------------------------------

/**
 * Replace every node's placeholder decode with the registry's verdict, and apply
 * IDL account names to the node's accounts (Req 7.12, 7.13).
 *
 * The tree builder cannot do this itself: the registry owns base58 decoding, hex
 * presentation, and truncation as one cohesive piece of behaviour, and it is the
 * sole producer of `InstructionDecode` so that `confidence` cannot be forged.
 * The pipeline is therefore where the two meet.
 *
 * Both operations happen here because this is the only place that holds all three
 * of the pieces they need: the node (its `accounts` and its `programId`), the
 * `RawInstruction` the node came from (its payload), and the registry (which IDL
 * governs the program). Naming is a second call rather than a field on the decode
 * because `InstructionDecode` has no channel for account names, and the names
 * belong on `AccountRef` where a reader already looks for them.
 *
 * **How a node is paired with the bytes it came from.** `InstructionNode` does
 * not carry its payload, so the pairing rests on Requirement 3.4: `order` is one
 * global counter in *transaction appearance order* across all depths. That is a
 * published property of `order` rather than an implementation detail of the tree
 * builder, so enumerating the response in appearance order and matching
 * position-for-position against the nodes sorted by `order` is sound, and stays
 * sound if the builder's internals change.
 *
 * The count check is not defensive padding — it is the one assumption of this
 * function stated as code. If the two enumerations ever disagree, every decode
 * after the divergence would land on the wrong instruction, and hex bytes of the
 * right shape under the wrong instruction is precisely the failure a reader
 * cannot spot. It is unreachable for any input, malformed or not, because both
 * enumerations derive from the same two arrays.
 */
function applyDecodes(
  response: RawTransactionResponse,
  tree: readonly InstructionNode[],
  registry: DecoderRegistry,
): readonly InstructionNode[] {
  const nodes = flattenByOrder(tree);
  const raw = inAppearanceOrder(response);

  /* c8 ignore start */
  if (nodes.length !== raw.length) {
    throw new Error(
      `internal: instruction tree holds ${nodes.length} nodes but the response ` +
        `carries ${raw.length} instructions in appearance order`,
    );
  }
  /* c8 ignore stop */

  const resolved = new Map<number, NodeDecode>();
  for (const [position, node] of nodes.entries()) {
    const instruction = raw[position];
    /* c8 ignore next */
    if (instruction === undefined) continue;
    resolved.set(node.order, {
      decode: registry.decodeInstruction(node.programId, instruction, node.accounts),
      // Returns `node.accounts` itself when no IDL entry applies, so the common
      // case allocates nothing and every `name` stays `null` (Req 7.13).
      accounts: registry.nameAccounts(node.programId, instruction, node.accounts),
    });
  }

  return mapInstructionTree(tree, (node, inner) => {
    const entry = resolved.get(node.order);
    /* c8 ignore next */
    if (entry === undefined) return { ...node, inner };
    return { ...node, decode: entry.decode, accounts: entry.accounts, inner };
  });
}

/** One node's two registry-derived fields, paired by `order`. */
interface NodeDecode {
  readonly decode: InstructionDecode;
  readonly accounts: readonly AccountRef[];
}

/** Every node in the tree, ascending by `order`. */
function flattenByOrder(tree: readonly InstructionNode[]): readonly InstructionNode[] {
  const nodes: InstructionNode[] = [];
  // The rewrite is a no-op; the walk is what is wanted, and reusing it keeps the
  // unbounded-depth guarantee instead of recursing here.
  mapInstructionTree(tree, (node, inner) => {
    nodes.push(node);
    return { ...node, inner };
  });
  return nodes.sort((a, b) => a.order - b.order);
}

/**
 * Every instruction in the response in transaction appearance order: each
 * top-level instruction followed by the CPI frames it invoked.
 *
 * Mirrors the tree builder's treatment of `meta.innerInstructions` on the two
 * points where the input can be awkward, because a node that is in the tree but
 * not in this list, or vice versa, breaks the pairing above. Groups are keyed
 * rather than indexed, so they need not arrive sorted by `index`; repeated
 * indices accumulate in encounter order rather than replacing one another; and a
 * group naming an index with no matching top-level instruction contributes
 * nothing, because no such node exists to pair with.
 */
function inAppearanceOrder(response: RawTransactionResponse): readonly RawInstruction[] {
  const topLevel = response.transaction.message.instructions;
  const byIndex = new Map<number, RawInstruction[]>();

  for (const group of response.meta?.innerInstructions ?? []) {
    const existing = byIndex.get(group.index);
    if (existing === undefined) {
      byIndex.set(group.index, [...group.instructions]);
    } else {
      existing.push(...group.instructions);
    }
  }

  const ordered: RawInstruction[] = [];
  for (const [index, instruction] of topLevel.entries()) {
    ordered.push(instruction);
    ordered.push(...(byIndex.get(index) ?? []));
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Small reads off the response
// ---------------------------------------------------------------------------

/**
 * The transaction's primary signature — the fee payer's, always first.
 *
 * The empty-array fallback is unreachable through the source layer, which
 * rejects a document whose `transaction.signatures` is not an array, and through
 * the CLI, which validates the signature before fetching. It is here so this
 * function is total rather than asserting: a pure stage should not be the thing
 * that throws on a malformed fixture.
 */
function primarySignature(response: RawTransactionResponse): Base58Signature {
  return response.transaction.signatures[0] ?? '';
}
