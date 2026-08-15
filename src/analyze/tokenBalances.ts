/**
 * SPL token balance deltas.
 *
 * Satisfies Requirement 20.
 *
 * The whole module is one join. `meta.preTokenBalances` and
 * `meta.postTokenBalances` are two flat arrays of `Token_Balance_Entry` values,
 * and the composite key (`accountIndex`, `mint`) is what turns them into rows:
 * matching on `accountIndex` alone would collapse two mints held by one account,
 * and matching on `mint` alone would collapse one mint held by two accounts.
 * Both shapes occur in `01-success-cpi-heavy`, which carries two mints across
 * seven token accounts (Req 20.2).
 *
 * Three rules run through everything below.
 *
 * - **No float, ever.** Arithmetic is `bigint`, output is a decimal string
 *   (Req 20.3, 20.7, 20.8). The RPC's `uiAmount` is a float and `uiAmountString`
 *   is derived from it; both are read off the type only to be discarded, and
 *   neither is referenced anywhere in this file. Only `uiTokenAmount.amount` —
 *   the exact base-unit integer string — and `uiTokenAmount.decimals` are read.
 * - **An amount never travels without its scale.** Every amount leaves here as a
 *   `TokenAmount`, binding the raw value to its mint and its `TokenDecimals`, so
 *   a renderer holding one always has the decimals it needs or explicit
 *   knowledge that it does not (Req 20.4, 12.11, 12.13).
 * - **Absent decimals are unknown, not defaulted.** `TokenDecimals` is a union
 *   precisely so that a missing or non-integral `decimals` is representable.
 *   Nothing here substitutes 9, or 6, or infers a value from the mint
 *   (Req 12.14).
 *
 * Output is sorted by (`accountIndex`, `mint`), so the collection does not
 * inherit the order the RPC happened to list its entries in (Req 9.1, 9.6).
 * `assemble.ts` sorts it again by the same key; that is not redundant belt and
 * braces but two different guarantees — this module's output is ordered whoever
 * calls it, and `Analysis`'s collections are ordered whoever produced them.
 */

import { resolveAccountRef, type EffectiveKeys } from '../decode/accountKeys.js';
import type {
  Base58Address,
  Confidence,
  RawTokenAmount,
  TokenAccountLifecycle,
  TokenAmount,
  TokenBalanceChange,
  TokenDecimals,
} from '../model/analysis.js';
import { minConfidence } from '../model/confidence.js';
import type { RawTokenBalance, RawTransactionResponse } from '../model/rawResponse.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Derive the token balance change collection for one response.
 *
 * Pure and total: it reads only its arguments, mutates neither, and has no
 * failure mode. Both arrays absent — a node that does not record token balances
 * — yields an empty collection rather than a fabricated row (Req 20.9), and so
 * does the `meta: null` case, for the same reason.
 *
 * `keys` supplies the address for each `accountIndex` through
 * `resolveAccountRef`, which is the single point of index resolution (Req 19.5).
 * A token balance entry naming an index outside the effective key list is
 * discussed at `addressOf` below.
 */
export function deriveTokenBalances(
  response: RawTransactionResponse,
  keys: EffectiveKeys,
): readonly TokenBalanceChange[] {
  const meta = response.meta;
  const pre = collect(meta?.preTokenBalances ?? null);
  const post = collect(meta?.postTokenBalances ?? null);

  const rows: TokenBalanceChange[] = [];
  for (const key of unionKeys(pre.sides, post.sides)) {
    if (pre.rejected.has(key) || post.rejected.has(key)) continue;
    const row = buildRow(keys, pre.sides.get(key) ?? null, post.sides.get(key) ?? null);
    if (row !== null) rows.push(row);
  }

  return sortRows(rows);
}

// ---------------------------------------------------------------------------
// Reading the two arrays
// ---------------------------------------------------------------------------

/**
 * One side of the join: an entry's key, its parsed amount, and its scale.
 *
 * `amount` is already a `bigint` here, so nothing downstream re-parses a string
 * or has to decide what a malformed one means — that decision is made once, on
 * read, in `parseAmount`.
 */
interface Side {
  readonly accountIndex: number;
  readonly mint: Base58Address;
  readonly amount: bigint;
  readonly decimals: TokenDecimals;
  /**
   * `true` when the array carried more than one entry for this key. The RPC does
   * not do this — a token account holds exactly one balance per mint at a point
   * in time — so it is a self-contradictory response, and the row it produces
   * says so rather than presenting a silent pick as fact.
   */
  readonly duplicated: boolean;
}

/** Keys are `accountIndex` and `mint` joined by a character base58 excludes. */
type CompositeKey = string;

function compositeKey(accountIndex: number, mint: Base58Address): CompositeKey {
  // '\u0000' cannot occur in a base58 address, so the encoding is injective and
  // no pair of distinct (index, mint) pairs can collide into one row.
  return `${accountIndex}\u0000${mint}`;
}

/** One array, indexed — plus the keys it disqualified. */
interface CollectedSide {
  readonly sides: ReadonlyMap<CompositeKey, Side>;
  /**
   * Keys whose entry carried an amount that is not an integer. They are tracked
   * rather than merely skipped so the *other* array's entry for the same key can
   * be suppressed too; `buildRow` explains why that has to be whole-key.
   */
  readonly rejected: ReadonlySet<CompositeKey>;
}

/**
 * Index one array by composite key, keeping the first entry per key.
 *
 * First rather than last, and the choice is arbitrary only in the sense that
 * both are wrong on contradictory input: what matters is that the row is marked
 * `duplicated` and loses `full` confidence, so the collapse is visible instead
 * of being an invisible last-write-wins.
 *
 * An entry whose `accountIndex` is not a safe integer or whose `mint` is not a
 * string has no composite key at all, so there is nothing to join it to and
 * nothing to suppress; it is dropped. An entry with a key but a malformed
 * `amount` lands in `rejected`.
 */
function collect(entries: readonly RawTokenBalance[] | null): CollectedSide {
  const sides = new Map<CompositeKey, Side>();
  const rejected = new Set<CompositeKey>();
  if (entries === null) return { sides, rejected };

  for (const entry of entries) {
    const accountIndex = entry?.accountIndex;
    const mint = entry?.mint;
    if (typeof accountIndex !== 'number' || !Number.isSafeInteger(accountIndex)) continue;
    if (typeof mint !== 'string') continue;

    const key = compositeKey(accountIndex, mint);
    const amount = parseAmount(entry.uiTokenAmount?.amount);
    if (amount === null) {
      rejected.add(key);
      continue;
    }

    const existing = sides.get(key);
    if (existing !== undefined) {
      sides.set(key, { ...existing, duplicated: true });
      continue;
    }

    sides.set(key, {
      accountIndex,
      mint,
      amount,
      decimals: readDecimals(entry.uiTokenAmount?.decimals),
      duplicated: false,
    });
  }

  return { sides, rejected };
}

/**
 * `uiTokenAmount.amount` as a `bigint`, or `null` when it is not an integer.
 *
 * The regex is the gate, not `BigInt`'s own leniency: `BigInt` accepts `'0x10'`,
 * `' 12 '`, and `''`, and each would put a value into `Analysis` that the input
 * did not contain. A rejected amount removes its whole composite key from the
 * join — both sides of it — rather than standing in for it as a zero; `buildRow`
 * explains why the removal cannot stop at the malformed side.
 *
 * `+5` normalizes to `5` and `-0` to `0` on the way out, via
 * `BigInt#toString`, which is what keeps every emitted amount in the one
 * spelling design.md's Property 27 checks for.
 */
function parseAmount(amount: unknown): bigint | null {
  if (typeof amount !== 'string') return null;
  if (!/^[+-]?[0-9]+$/.test(amount)) return null;
  return BigInt(amount);
}

/**
 * `uiTokenAmount.decimals` as a `TokenDecimals`.
 *
 * Absent, null, fractional, negative, or not a number at all → the `known:
 * false` variant. That variant is not a failure state, it is the honest one: a
 * renderer that receives it prints base units and labels them as such at
 * `partial` confidence (Req 12.13), which is strictly better than printing a
 * confidently misplaced decimal point.
 */
function readDecimals(decimals: unknown): TokenDecimals {
  if (typeof decimals !== 'number') return { known: false };
  if (!Number.isSafeInteger(decimals) || decimals < 0) return { known: false };
  return { known: true, value: decimals };
}

/**
 * Every key present in either side, pre-side keys first.
 *
 * The iteration order does not reach the output — `sortRows` decides that — so
 * this only has to be deterministic, which it is: `Map` iterates in insertion
 * order and both maps were filled from array order.
 */
function unionKeys(
  pre: ReadonlyMap<CompositeKey, Side>,
  post: ReadonlyMap<CompositeKey, Side>,
): readonly CompositeKey[] {
  const keys = new Set<CompositeKey>(pre.keys());
  for (const key of post.keys()) keys.add(key);
  return [...keys];
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

/**
 * Build the row for one composite key.
 *
 * The three lifecycles are the three inhabited combinations of the two sides:
 *
 * | pre | post | delta         | lifecycle  | requirement |
 * | --- | ---- | ------------- | ---------- | ----------- |
 * | yes | yes  | `post - pre`  | `existing` | 20.3        |
 * | no  | yes  | `post`        | `created`  | 20.5        |
 * | yes | no   | `-pre`        | `closed`   | 20.6        |
 *
 * The fourth combination — neither side — cannot arise, because a key exists in
 * the union only because it came from one of the maps. It returns `null` rather
 * than throwing so this function is total, and `deriveTokenBalances` skips it.
 *
 * **Why a rejected amount removes the whole key and not just its side.** If
 * `post` carried a malformed amount and were simply dropped, the surviving `pre`
 * would render as `lifecycle: 'closed'` with a negated delta — a specific,
 * confident, false claim that the transaction emptied an account. Silence about
 * a row is a smaller error than a fabricated closure, so a key with a malformed
 * amount on either side contributes no row at all. Requirement 20 names no gap
 * case for a malformed amount; no recorded fixture contains one, and this is the
 * reading of 20.3 that cannot state something untrue.
 */
function buildRow(
  keys: EffectiveKeys,
  pre: Side | null,
  post: Side | null,
): TokenBalanceChange | null {
  const identity = post ?? pre;
  /* c8 ignore next */
  if (identity === null) return null;

  const mint = identity.mint;
  const scale = mintScale(pre, post);
  const { address, addressConfidence } = addressOf(keys, identity.accountIndex);

  const lifecycle: TokenAccountLifecycle =
    pre === null ? 'created' : post === null ? 'closed' : 'existing';
  const deltaAmount =
    (post === null ? 0n : post.amount) - (pre === null ? 0n : pre.amount);

  const markers: Confidence[] = [addressConfidence];
  // An unknown scale caps the row at `partial`: the amounts are exact, but the
  // row cannot say what they are exact *in*.
  if (!scale.known) markers.push('partial');
  if (pre?.duplicated === true || post?.duplicated === true) markers.push('partial');

  return {
    accountIndex: identity.accountIndex,
    address,
    mint,
    // `null` on the created and closed rows respectively, which is the model's
    // spelling of "there was no balance to read" (Req 20.5, 20.6) and is
    // different from a zero balance that was read.
    pre: pre === null ? null : amountOf(mint, pre.amount, pre.decimals),
    post: post === null ? null : amountOf(mint, post.amount, post.decimals),
    delta: amountOf(mint, deltaAmount, scale),
    lifecycle,
    confidence: minConfidence('full', markers),
  };
}

/**
 * The scale to put on the delta.
 *
 * `decimals` is a property of the mint, so a matched pair reports it twice and
 * the two reports should agree. When they disagree the response contradicts
 * itself, and the delta — the one value derived from *both* entries — is given
 * the `known: false` variant rather than one of the two candidates. Picking
 * either would be picking without a reason, and a base-unit subtraction across
 * two different scales is not a quantity in either of them; `known: false` is
 * the only honest scale for it, and it drops the row to `partial` above.
 *
 * The individual `pre` and `post` amounts keep the `decimals` reported beside
 * each of them (Req 20.4 reads the value "from the Token_Balance_Entry"), so
 * nothing the response said is discarded — the contradiction stays visible in
 * the output instead of being resolved out of sight.
 */
function mintScale(pre: Side | null, post: Side | null): TokenDecimals {
  if (pre === null) return post?.decimals ?? { known: false };
  if (post === null) return pre.decimals;
  if (!pre.decimals.known || !post.decimals.known) return { known: false };
  if (pre.decimals.value !== post.decimals.value) return { known: false };
  return pre.decimals;
}

/** A raw `bigint` amount bound to its mint and its scale (Req 20.4). */
function amountOf(mint: Base58Address, amount: bigint, decimals: TokenDecimals): TokenAmount {
  const raw: RawTokenAmount = amount.toString();
  return { mint, raw, decimals };
}

/**
 * The address for an `accountIndex`, and what that lookup costs in confidence.
 *
 * `TokenBalanceChange.address` is a non-nullable `Base58Address`, so an index
 * that does not resolve has no "we do not know" spelling available the way
 * `InstructionNode.programId` does. The empty string is used, and the row's
 * confidence drops to `raw` so no reader mistakes it for an address that was
 * looked up successfully — a `raw` marker on the row is the model's available
 * way of saying the identity of the account is not attested. The row is still
 * emitted, because `accountIndex`, `mint`, and the amounts are all real and the
 * balance change genuinely happened.
 *
 * Unreachable for any response a node produces: token balance entries index the
 * same effective key list the instructions do.
 */
function addressOf(
  keys: EffectiveKeys,
  accountIndex: number,
): { readonly address: Base58Address; readonly addressConfidence: Confidence } {
  const ref = resolveAccountRef(keys, accountIndex);
  if (ref.kind === 'resolved') {
    return { address: ref.address, addressConfidence: 'full' };
  }
  return { address: '', addressConfidence: 'raw' };
}

// ---------------------------------------------------------------------------
// Ordering — Requirements 9.1, 9.6, 9.7
// ---------------------------------------------------------------------------

/**
 * Ascending by (`accountIndex`, `mint`).
 *
 * `mint` is compared by UTF-16 code unit, never with `localeCompare`, whose
 * result depends on `LANG`/`LC_ALL` and would let one input produce two
 * different orderings on two machines (Req 9.7).
 */
function sortRows(rows: readonly TokenBalanceChange[]): readonly TokenBalanceChange[] {
  return [...rows].sort(
    (a, b) => a.accountIndex - b.accountIndex || compareCodeUnits(a.mint, b.mint),
  );
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
