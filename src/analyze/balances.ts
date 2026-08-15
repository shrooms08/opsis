/**
 * Lamport balance deltas — the analysis layer's read of `meta.preBalances` and
 * `meta.postBalances`, and the one stage that populates
 * `AccountEntry.referencedBy`.
 *
 * Satisfies Requirements 7.8-7.11.
 *
 * Four rules carry this module:
 *
 * - **Arithmetic is `bigint`, output is a decimal string.** `post - pre` is
 *   computed on `bigint` values and narrowed with `toString()`, which emits a
 *   plain signed decimal integer for every magnitude. There is no `Number(...)`
 *   call, no `/`, no `toFixed`, and no `parseFloat` anywhere below
 *   (Req 7.10, 9.2, 13.8). A `number` that arrived on the wire is widened to
 *   `bigint` exactly once, by `BigInt(...)`, and never participates in
 *   arithmetic as a `number`.
 * - **No unit conversion.** Lamports in, lamports out. SOL exists only in the
 *   text renderer (Req 7.10, 12.5, 12.10); the word does not appear in the
 *   analysis layer, and neither does a divisor.
 * - **Absence is a variant, not a zero.** Pre absent with post present yields
 *   the `post-only` variant, which has no `delta` key at all (Req 7.9), rather
 *   than a delta computed against an assumed pre-balance of zero. A new account
 *   funded by the transaction and an account whose balance did not change are
 *   different facts and get different shapes.
 * - **Attribution is a full-depth walk.** `referencedBy` collects the `order` of
 *   every instruction at every depth whose account list names the index
 *   (Req 7.11), not just the top-level ones: an account touched only inside a CPI
 *   was still touched.
 *
 * ## Precision, stated honestly
 *
 * `RawMeta.preBalances` is `readonly number[]` because that is what the RPC
 * sends and what `JSON.parse` produces. A balance above 2^53 has therefore
 * already lost precision before this module runs, and nothing here can recover
 * it. What this module guarantees is that no *further* loss happens: the
 * `bigint` widening is exact for every integer-valued double, including those
 * above 2^53, so the delta of two such balances is exact with respect to the
 * values as received, and the decimal string carries every digit of it.
 *
 * ## Two shapes the model cannot express
 *
 * `LamportBalanceChange` has exactly two variants — `delta` and `post-only` —
 * and two inputs fit neither. Both are reported through `unrepresented` rather
 * than dropped or approximated, because a fabricated entry is worse than a
 * named absence:
 *
 * - **Pre present, post absent.** The RPC should not produce this: the post
 *   balance is the settled state, so an account with a pre-balance has a
 *   post-balance. There is no `pre-only` variant to emit, a `post-only` entry
 *   carrying the pre-balance would misreport a stale value as settled, and a
 *   delta would have to be invented. The index is recorded as
 *   `post-balance-absent` instead.
 * - **An index with no address.** The balance arrays are indexed against the
 *   *effective* key list, so a v0 message whose `meta.loadedAddresses` is absent
 *   yields balances for indices past the end of the resolvable list
 *   (Req 19.6). Every variant requires a `Base58Address`, and there is no
 *   spelling for "a balance belonging to an account we cannot name" — an empty
 *   string or a placeholder would be a false address in a field typed to hold a
 *   real one. Those indices are recorded as `address-unresolved`.
 *
 * `referencedBy` attribution is unaffected by either: it is keyed on the
 * instruction tree, not on the balance arrays.
 *
 * This function is pure and total. It reads only its arguments, mutates nothing
 * it was given, and has no failure mode.
 */

import type { EffectiveKeys } from '../decode/accountKeys.js';
import type {
  AccountEntry,
  InstructionNode,
  LamportAmount,
  LamportBalanceChange,
} from '../model/analysis.js';
import type { RawTransactionResponse } from '../model/rawResponse.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Why an account's balance could not be expressed as a `LamportBalanceChange`. */
export type UnrepresentedReason =
  /** A pre-balance with no post-balance; see the module note. */
  | 'post-balance-absent'
  /** The index has no entry in the effective account key list (Req 19.6). */
  | 'address-unresolved';

/**
 * One balance the model has no variant for, named rather than silently dropped.
 *
 * Nothing in v1 renders this collection — it is the honest residue of a shape
 * mismatch, kept so a reader of the analysis layer can see that an input was
 * observed and deliberately not represented, and so a future renderer or
 * diagnostic has something to read that is not a reconstruction.
 */
export interface UnrepresentedBalance {
  readonly accountIndex: number;
  readonly reason: UnrepresentedReason;
  /** Human-readable statement of what was seen. */
  readonly detail: string;
}

export interface LamportBalanceAnalysis {
  /** Ascending by `accountIndex` (Req 7.8, 7.9). */
  readonly balances: readonly LamportBalanceChange[];
  /**
   * The effective key list with `referencedBy` populated (Req 7.11), in the
   * order it arrived. Every other field is carried through untouched.
   */
  readonly accountKeys: readonly AccountEntry[];
  /** Ascending by `accountIndex`. Empty for every well-formed response. */
  readonly unrepresented: readonly UnrepresentedBalance[];
}

/**
 * Zip `meta.preBalances` with `meta.postBalances` and attribute instruction
 * references to accounts.
 *
 * `instructions` is the top-level instruction list; nested nodes are reached
 * through `inner` at every depth. The walk is iterative, matching the
 * unbounded-depth guarantee the tree builder and `assemble.ts` both keep
 * (Req 3.6): a CPI chain deep enough to be built must be deep enough to
 * describe.
 */
export function analyzeLamportBalances(
  response: RawTransactionResponse,
  keys: EffectiveKeys,
  instructions: readonly InstructionNode[],
): LamportBalanceAnalysis {
  const meta = response.meta ?? null;
  const pre = meta?.preBalances ?? [];
  const post = meta?.postBalances ?? [];

  const balances: LamportBalanceChange[] = [];
  const unrepresented: UnrepresentedBalance[] = [];

  // One pass over the union of both arrays' index spaces, so an account present
  // in only one of them is still visited rather than depending on which array
  // happens to be longer.
  const count = pre.length > post.length ? pre.length : post.length;
  for (let index = 0; index < count; index += 1) {
    const preLamports = toLamports(pre[index]);
    const postLamports = toLamports(post[index]);

    if (postLamports === null) {
      if (preLamports !== null) {
        unrepresented.push({
          accountIndex: index,
          reason: 'post-balance-absent',
          detail:
            `account index ${index} has a pre-transaction balance but no ` +
            `post-transaction balance, so neither a delta nor a settled balance ` +
            `can be reported`,
        });
      }
      // Neither balance usable: the index belongs to no account this response
      // recorded a balance for, and there is nothing to report.
      continue;
    }

    const address = keys.entries[index]?.address;
    if (address === undefined) {
      unrepresented.push({
        accountIndex: index,
        reason: 'address-unresolved',
        detail:
          `account index ${index} carries a balance but is out of range for the ` +
          `effective account key list of ${keys.entries.length} entries, so the ` +
          `balance cannot be attributed to an address`,
      });
      continue;
    }

    if (preLamports === null) {
      // Req 7.9. `post-only` carries no `delta` key, by construction of the type.
      balances.push({
        kind: 'post-only',
        accountIndex: index,
        address,
        post: decimal(postLamports),
        confidence: 'partial',
      });
      continue;
    }

    // Req 7.8. The subtraction is the only arithmetic in this module, and it is
    // `bigint` subtraction.
    balances.push({
      kind: 'delta',
      accountIndex: index,
      address,
      pre: decimal(preLamports),
      post: decimal(postLamports),
      delta: decimal(postLamports - preLamports),
      confidence: 'full',
    });
  }

  return {
    // Sorted here rather than left to `assemble.ts` so this module's own output
    // is independent of the order the RPC arrays happened to arrive in. The loop
    // above already walks ascending, so this is a restatement of an invariant
    // rather than a repair; `assemble.ts` sorts again because it guarantees the
    // ordering of the assembled object for every producer, not just this one.
    balances: balances.sort(byAccountIndex),
    accountKeys: attributeReferences(keys.entries, instructions),
    unrepresented: unrepresented.sort(byAccountIndex),
  };
}

// ---------------------------------------------------------------------------
// Lamport values
// ---------------------------------------------------------------------------

/**
 * Widen one wire balance to `bigint`, or `null` when there is no usable value.
 *
 * `undefined` is the absent case — a short array, or an index past the end. The
 * integrality check covers the malformed cases: `BigInt(1.5)`, `BigInt(NaN)`,
 * and `BigInt(Infinity)` all throw, and a pure stage should not be the thing
 * that throws on a malformed fixture, so a non-integer balance is treated as no
 * balance rather than as a value to round. Rounding would produce a plausible
 * number with the wrong digits, which is the failure this whole representation
 * exists to prevent.
 *
 * `Number.isInteger` is a predicate, not a conversion: it reads the value and
 * returns a boolean. No numeric value flows through it.
 */
function toLamports(value: number | undefined): bigint | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value)) return null;
  return BigInt(value);
}

/**
 * Narrow a `bigint` to the decimal string `LamportAmount` spells.
 *
 * `BigInt.prototype.toString` with no radix is plain base-10 with a leading `-`
 * for negatives and no separators, exponent, or locale influence — unlike
 * `Number.prototype.toString`, which switches to exponential notation for large
 * magnitudes. Zero is `"0"`, not `"-0"`, because `bigint` has no negative zero.
 */
function decimal(value: bigint): LamportAmount {
  return value.toString();
}

// ---------------------------------------------------------------------------
// Instruction attribution — Requirement 7.11
// ---------------------------------------------------------------------------

/**
 * Populate `referencedBy` on every entry from a full-depth walk of the tree.
 *
 * Orders are ascending and deduplicated: an instruction that names the same
 * account in two of its slots referenced it once, and a reader comparing an
 * account's `referencedBy` against the instruction list should see each order at
 * most once.
 *
 * Only the `resolved` variant of `AccountRef` contributes. The `unresolved`
 * variant carries the index it was asked about, but that index named no entry —
 * it is out of range, or it depends on lookup data the response does not carry
 * (Req 19.5, 19.6) — so there is no account to attribute the reference to.
 * Recording it against the raw number would put a reference on whichever entry
 * later happened to occupy that position.
 */
function attributeReferences(
  entries: readonly AccountEntry[],
  instructions: readonly InstructionNode[],
): readonly AccountEntry[] {
  const orders = new Map<number, Set<number>>();

  for (const node of flatten(instructions)) {
    for (const account of node.accounts) {
      if (account.kind !== 'resolved') continue;
      const existing = orders.get(account.index);
      if (existing === undefined) {
        orders.set(account.index, new Set([node.order]));
      } else {
        existing.add(node.order);
      }
    }
  }

  return entries.map((entry) => {
    const referenced = orders.get(entry.index);
    if (referenced === undefined) return { ...entry, referencedBy: [] };
    return { ...entry, referencedBy: [...referenced].sort((a, b) => a - b) };
  });
}

/**
 * Every node in the tree, at every depth, in no guaranteed order.
 *
 * Iterative for the reason `mapInstructionTree` is (Req 3.6): `inner` is
 * unbounded and recursing over it would make a deep CPI chain undescribable.
 * `mapInstructionTree` itself is not reused here because it *rebuilds* the tree
 * to collect its nodes, allocating a copy of every node and every array on it;
 * this walk only reads, and nothing about the ordering of the visit matters
 * because the orders it collects are sorted afterwards.
 */
function flatten(roots: readonly InstructionNode[]): readonly InstructionNode[] {
  const nodes: InstructionNode[] = [];
  const stack: InstructionNode[] = [...roots];

  while (stack.length > 0) {
    const node = stack.pop();
    /* c8 ignore next */
    if (node === undefined) break;
    nodes.push(node);
    stack.push(...node.inner);
  }

  return nodes;
}

function byAccountIndex(
  a: { readonly accountIndex: number },
  b: { readonly accountIndex: number },
): number {
  return a.accountIndex - b.accountIndex;
}
