/**
 * `RawTransactionResponse` — the untrusted, verbatim `getTransaction` shape.
 *
 * This is the *input* side of the tool, and it is deliberately a different kind
 * of type from `Analysis` in `./analysis.js`:
 *
 * - **This file is what a node said.** It is JSON that arrived over a wire or
 *   was replayed from a fixture file. It is untrusted: fields may be absent,
 *   null, empty, mutually inconsistent, or numerically lossy.
 * - **`Analysis` is what we concluded.** Every value in it has been checked,
 *   normalized, and given a confidence. Nothing crosses from here to there
 *   without a check.
 *
 * Consequently nothing here is assumed present. Where the RPC can leave a field
 * out, the field is optional; where the RPC sends an explicit `null`, the field
 * is present and nullable. Reads go through `?.`, `??`, and explicit `null`
 * comparisons rather than assertions.
 *
 * **Why this lives in `model/` and not in `source/`.** design.md introduces
 * `RawTransactionResponse` in the `source/` section, because that is where it
 * enters the process. It lives here instead because six modules *read* it —
 * `decode/accountKeys.ts`, `decode/instructionTree.ts`, `resolve/failure.ts`,
 * `resolve/logs.ts`, and the balance and compute extractors — while exactly one
 * module *fetches* it. Placing it next to the fetcher would either make every
 * reader import from `source/` (coupling pure decode to the I/O layer) or
 * tempt each reader into declaring its own local copy. Local copies drift, and
 * the drift would surface as a golden-fixture mismatch that reads like a decode
 * bug. One canonical structural type, imported everywhere, removes that class
 * of failure. This is a knowing deviation from design.md's file placement, not
 * an oversight.
 *
 * The shape below was derived from the six recorded fixtures in
 * `tests/golden/*​/input.json` rather than from documentation, so it describes a
 * surface that has actually been observed. Field-level notes record which of
 * the six carried what.
 *
 * Structural, not nominal: no web3.js class appears here, so a fixture file and
 * a live response are literally the same input (Req 10.5).
 */

import type { Base58Address, Base58Signature } from './analysis.js';

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/**
 * One `getTransaction` result, in `json` encoding, verbatim.
 *
 * A `null` result (signature not found) is not modeled here — the source layer
 * turns that into a `SourceError` before a response object ever exists.
 */
export interface RawTransactionResponse {
  /** Slot the transaction was processed in. Present in all six fixtures. */
  readonly slot: number;
  /**
   * Unix seconds. The key is always sent; the value is `null` when the node has
   * no block time for the slot. All six fixtures carry a number.
   */
  readonly blockTime: number | null;
  /**
   * `0` for a versioned (v0) message, the string `'legacy'` for a legacy one.
   *
   * Optional rather than required: the field is omitted entirely by responses
   * fetched without `maxSupportedTransactionVersion`, and such a response is
   * legacy by definition. Five fixtures carry `0`; `03-program-table-error`
   * carries `'legacy'`.
   */
  readonly version?: 0 | 'legacy';
  readonly transaction: RawTransaction;
  /**
   * Transaction metadata. The key is always sent; the value is `null` when the
   * node did not store metadata for this transaction, in which case there are
   * no balances, no logs, and no lookup-table resolution to read. All six
   * fixtures carry an object.
   */
  readonly meta: RawMeta | null;
  /**
   * Position of the transaction within its block. Present in all six fixtures
   * and **ignored by the pipeline** — nothing in `Analysis` depends on where in
   * a block a transaction landed. Declared so that the type documents the whole
   * observed surface rather than only the part that is consumed.
   */
  readonly transactionIndex?: number;
}

export interface RawTransaction {
  readonly message: RawMessage;
  /** Base58 signatures, fee payer first. Present in all six fixtures. */
  readonly signatures: readonly Base58Signature[];
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export interface RawMessage {
  /**
   * Static account keys, in message order. Base58 as delivered; never
   * re-encoded on the way through (Req 7.14).
   */
  readonly accountKeys: readonly Base58Address[];
  readonly header: RawMessageHeader;
  /** Top-level instructions, in execution order. */
  readonly instructions: readonly RawInstruction[];
  readonly recentBlockhash: string;
  /**
   * v0 lookup-table references. Omitted entirely on a legacy message —
   * `03-program-table-error` has no such key at all, so this is `?:` and not
   * `| null`. The resolved addresses live in `meta.loadedAddresses`; this array
   * is the *request*, not the answer.
   */
  readonly addressTableLookups?: readonly RawAddressTableLookup[];
}

/** Message header counts, per the Solana message layout. Req 7.4. */
export interface RawMessageHeader {
  readonly numRequiredSignatures: number;
  readonly numReadonlySignedAccounts: number;
  readonly numReadonlyUnsignedAccounts: number;
}

/**
 * A compiled instruction, used for both `message.instructions` and the entries
 * inside `meta.innerInstructions`.
 */
export interface RawInstruction {
  /** Index into the effective account key list. May be out of range. */
  readonly programIdIndex: number;
  /** Indices into the effective account key list, in instruction order. */
  readonly accounts: readonly number[];
  /** Instruction data, **base58** in `json` encoding (not base64, not hex). */
  readonly data: string;
  /**
   * CPI depth: 1 for a top-level instruction, 2 for its direct callee, and so
   * on. Optional and nullable: all six fixtures carry a number on both
   * top-level and inner instructions, but older nodes omit it, and the tree
   * builder must fall back to flat parentage marked `partial` when it is
   * missing (design.md, `decode/instructionTree.ts`).
   */
  readonly stackHeight?: number | null;
}

export interface RawAddressTableLookup {
  readonly accountKey: Base58Address;
  readonly writableIndexes: readonly number[];
  readonly readonlyIndexes: readonly number[];
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export interface RawMeta {
  /**
   * The runtime error, or `null` on success. The key is always sent, so this is
   * `| null` and not `?:` — `err === null` is the success signal the pipeline
   * reads (Req 22.1). `01-success-cpi-heavy` is the `null` case; the other five
   * carry `{ InstructionError: [index, detail] }`.
   */
  readonly err: RawTransactionError | null;
  /** Fee in lamports, as a JSON number. See the precision note below. */
  readonly fee: number;
  /**
   * Lamport balances before and after, indexed by static account index. Present
   * in all six fixtures.
   *
   * These arrive as JSON numbers, so a balance above 2^53 has already lost
   * precision inside `JSON.parse` before any code here runs. That is a property
   * of the RPC surface, not something this tool can recover; the lamport values
   * in `Analysis` are decimal strings (Req 9.2, 13.8) computed from these
   * doubles, and the string spelling prevents *further* loss, not the loss that
   * already happened at the wire.
   */
  readonly preBalances: readonly number[];
  readonly postBalances: readonly number[];
  /**
   * SPL token balances before and after. Optional and nullable: a node without
   * token balance recording omits them. All six fixtures carry populated
   * arrays.
   */
  readonly preTokenBalances?: readonly RawTokenBalance[] | null;
  readonly postTokenBalances?: readonly RawTokenBalance[] | null;
  /**
   * CPI instructions, grouped by the top-level index that invoked them.
   * Optional and nullable: a node without inner instruction recording omits
   * the field, which is different from an empty array meaning "recorded, and
   * there were none". Four fixtures carry groups; `04` and `07` carry `[]`.
   */
  readonly innerInstructions?: readonly RawInnerInstructionGroup[] | null;
  /**
   * Program log output, in emission order. Optional and nullable: log recording
   * can be disabled, and truncation is reported inside the array itself rather
   * than by a separate flag (Req 21.5, 21.6). All six fixtures carry an array.
   */
  readonly logMessages?: readonly string[] | null;
  /**
   * Lookup-table resolution result (Req 19.4). Optional and nullable.
   *
   * Fixture evidence worth keeping: the legacy fixture `03` *also* carries this
   * key, with both arrays empty. Presence of the field therefore says nothing
   * about the message version, which is why `resolveAccountKeys` gates on
   * `version` and treats `loadedAddressesAvailable` as an observation rather
   * than a verdict.
   */
  readonly loadedAddresses?: RawLoadedAddresses | null;
  /**
   * Total compute units consumed. Optional: older nodes omit it, and the
   * absence is reported as `available: false` rather than as a zero (Req 4.x,
   * design Property 28). Present in all six fixtures. Never summed from
   * per-instruction values.
   */
  readonly computeUnitsConsumed?: number;
  /**
   * Data returned by the last program to call `set_return_data`. Optional and
   * nullable; only `02-anchor-user-error` carries it.
   */
  readonly returnData?: RawReturnData | null;
  /**
   * Block rewards attributed to this transaction. Optional and nullable. All
   * six fixtures carry `[]`, so the element shape below is unexercised by any
   * fixture and is modeled conservatively.
   */
  readonly rewards?: readonly RawReward[] | null;
  /**
   * Deprecated duplicate of `err` in `{ Ok: null } | { Err: ... }` spelling.
   * Present in all six fixtures and **ignored by the pipeline**, which reads
   * `err`. Declared so nobody reintroduces it as a second source of truth.
   */
  readonly status?: RawTransactionStatus;
  /**
   * Total cost units, a newer scheduler-oriented figure that is *not* compute
   * units. Present in all six fixtures and **ignored by the pipeline**: the
   * compute report carries `computeUnitsConsumed` verbatim, and mixing the two
   * would silently change a reported number.
   */
  readonly costUnits?: number;
}

/** `meta.loadedAddresses` — addresses resolved through lookup tables. */
export interface RawLoadedAddresses {
  readonly writable: readonly Base58Address[];
  readonly readonly: readonly Base58Address[];
}

/** One top-level index and the CPI instructions executed beneath it. */
export interface RawInnerInstructionGroup {
  /** Index into `message.instructions`. */
  readonly index: number;
  readonly instructions: readonly RawInstruction[];
}

export interface RawReturnData {
  readonly programId: Base58Address;
  /** `[payload, encoding]`; the recorded encoding is always `'base64'`. */
  readonly data: readonly [data: string, encoding: 'base64'];
}

/**
 * A block reward entry. No fixture exercises this — all six carry
 * `rewards: []` — so every field except `pubkey` is optional or nullable and
 * nothing about it is load-bearing.
 */
export interface RawReward {
  readonly pubkey: Base58Address;
  readonly lamports: number;
  readonly postBalance?: number;
  readonly rewardType?: string | null;
  readonly commission?: number | null;
}

// ---------------------------------------------------------------------------
// Token balances
// ---------------------------------------------------------------------------

export interface RawTokenBalance {
  /** Index into the effective account key list. */
  readonly accountIndex: number;
  readonly mint: Base58Address;
  /**
   * Owner of the token account. Optional: the field predates neither the RPC
   * nor every node build, and a response may omit it. All six fixtures carry
   * it, and `06-nested-cpi-failure` shows both Token and Token-2022 accounts
   * side by side.
   */
  readonly owner?: Base58Address;
  /**
   * Owning token program — Tokenkeg… or TokenzQd… — which is how a Token-2022
   * balance is told apart from a legacy one. Optional for the same reason as
   * `owner`; present in all six fixtures.
   */
  readonly programId?: Base58Address;
  readonly uiTokenAmount: RawUiTokenAmount;
}

/**
 * A token amount as the RPC spells it: one exact value and two lossy
 * conveniences.
 */
export interface RawUiTokenAmount {
  /** Exact amount in the mint's smallest unit, as a decimal string. */
  readonly amount: string;
  /** Mint decimals. Meaningless apart from `amount`; the two travel together. */
  readonly decimals: number;
  /**
   * **A float, read only to be discarded (Req 20.8).** It exists in this type
   * so that its presence in the input is documented and so a reviewer can see
   * that no code path forwards it; it must never reach `Analysis`, where token
   * amounts are decimal strings paired with `decimals`.
   *
   * Nullable, and the fixtures prove why the nullability matters rather than
   * being defensive: `01` and `04` carry `uiAmount: null` on entries whose
   * `amount` is a perfectly good integer string, so a consumer that reached for
   * `uiAmount` would have found nothing where the exact value was available all
   * along. `07` carries a whole number and the rest carry true floats.
   */
  readonly uiAmount: number | null;
  /**
   * Decimal-formatted convenience string, also discarded. Optional because it
   * is a formatting artifact rather than data; present in all six fixtures.
   */
  readonly uiAmountString?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * `meta.err`, as the runtime serializes a `TransactionError`.
 *
 * Two spellings reach the wire: a bare string for unit-like variants
 * (`"AlreadyProcessed"`), and a single-key object for variants that carry data.
 * The only variant this tool interprets is `InstructionError`, so that one is
 * typed and everything else stays `unknown` behind an index signature — an
 * unrecognized variant must render as-is rather than fail to parse (Req 6.x).
 */
export type RawTransactionError = string | RawTransactionErrorObject;

export interface RawTransactionErrorObject {
  /**
   * `[topLevelInstructionIndex, detail]`. The index names a **top-level**
   * instruction only, never a nested CPI frame (Req 5.2), and it is not
   * guaranteed to be in range (Req 5.4). All five failing fixtures use this
   * variant.
   */
  readonly InstructionError?: readonly [index: number, detail: RawInstructionErrorDetail];
  /** Any other variant, e.g. `{ DuplicateInstruction: 3 }`. */
  readonly [variant: string]: unknown;
}

/**
 * The second element of `InstructionError`: a bare string for built-in runtime
 * failures (`"InvalidAccountData"`) or a single-key object, of which `Custom`
 * carries the program's own error code. All five failing fixtures use
 * `{ Custom: n }`.
 */
export type RawInstructionErrorDetail = string | RawInstructionErrorDetailObject;

export interface RawInstructionErrorDetailObject {
  /** Program-defined error code, e.g. 6040 for an Anchor user error. */
  readonly Custom?: number;
  readonly [variant: string]: unknown;
}

/**
 * `meta.status`. Deprecated and ignored; see `RawMeta.status`.
 */
export type RawTransactionStatus =
  | { readonly Ok: null }
  | { readonly Err: RawTransactionError };
