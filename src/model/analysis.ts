/**
 * The Analysis data model — the single contract between decode and render.
 *
 * `expected.json` in every fixture directory is the canonical serialization of
 * one `Analysis`, so a change to any type here is a change to every golden
 * file, deliberately.
 *
 * Two conventions run through the whole file:
 *
 * - Lamports and token amounts are decimal `string`s, not `number` and not
 *   `bigint`. `number` silently rounds a `u64`; `bigint` is not
 *   JSON-representable. Arithmetic is done in `bigint` and narrowed back to a
 *   string at the boundary. Requirements 9.2, 13.8, 20.7, 20.8.
 * - Absence has two spellings. `T | null` is always present and states "we
 *   looked and it is not there". `?: T` is omitted from the serialization when
 *   `undefined`, per Requirement 13.7.
 */

import type { Confidence } from './confidence.js';

export type { Confidence };

/** Base58-encoded account address. Requirement 7.14. */
export type Base58Address = string;

/** Base58-encoded 64-byte transaction signature. Requirement 1.1. */
export type Base58Signature = string;

/** Lowercase hex, "0x" prefixed. Requirement 11.5. */
export type HexString = string;

/**
 * Signed decimal integer string in lamports. Never a float, never SOL.
 * Requirements 7.10, 9.2, 13.8.
 */
export type LamportAmount = string;

/**
 * Signed decimal integer string in a mint's smallest base unit.
 * Meaningless without the matching decimals value; never carried alone.
 * Requirements 20.7, 20.8.
 */
export type RawTokenAmount = string;

export type MessageVersion = 'legacy' | 'v0';

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/**
 * The single boundary between decode and render.
 *
 * Contains only strings, safe integers, booleans, null, arrays, and plain
 * objects. No Date, no Map, no class instance, no floating-point number.
 * Contains no indication of whether the data came from a fixture or the
 * network, because both must produce identical output (Requirement 10.5), and
 * no timestamp, process id, or duration (Requirement 9.5).
 */
export interface Analysis {
  readonly signature: Base58Signature;
  /** Requirement 19.1. */
  readonly messageVersion: MessageVersion;
  readonly outcome: TransactionOutcome;
  /** Effective account key list, in effective order. Requirement 19.2, 19.3. */
  readonly accountKeys: readonly AccountEntry[];
  /** Top-level instructions, ascending by order. Requirement 3.4. */
  readonly instructions: readonly InstructionNode[];
  /** Non-null exactly when the transaction failed. Requirement 5. */
  readonly failure: FailureReport | null;
  /** Ascending by accountIndex. Requirement 7.8, 7.9. */
  readonly lamportBalances: readonly LamportBalanceChange[];
  /** Ascending by (accountIndex, mint). Requirement 20. */
  readonly tokenBalances: readonly TokenBalanceChange[];
  readonly compute: ComputeReport;
  readonly logs: LogReport;
}

export interface TransactionOutcome {
  /** false implies exit code 1. Requirement 22.1, 22.2. */
  readonly succeeded: boolean;
  /** Requirement 6.4. */
  readonly error: ResolvedError | null;
}

// ---------------------------------------------------------------------------
// Accounts — Requirements 7, 19
// ---------------------------------------------------------------------------

export type AccountRole = 'writable' | 'readonly';

/**
 * Where an address came from, which determines how its role was derived.
 * Requirements 7.4-7.7, 19.7.
 */
export type AccountOrigin =
  | { readonly kind: 'static' }
  | {
      readonly kind: 'lookup-table';
      /** Which loadedAddresses array the address appeared in. */
      readonly loadedFrom: 'writable' | 'readonly';
    };

export interface AccountEntry {
  /** Position in the effective account key list. */
  readonly index: number;
  readonly address: Base58Address;
  /** Always false for lookup-table addresses. Requirement 7.7. */
  readonly signer: boolean;
  /** Header for static keys; source array for lookup-table addresses. */
  readonly role: AccountRole;
  readonly origin: AccountOrigin;
  /** Instruction orders referencing this account, ascending. Requirement 7.11. */
  readonly referencedBy: readonly number[];
  /** From an Anchor IDL when available. Requirement 7.12, 7.13. */
  readonly name: string | null;
  readonly confidence: Confidence;
}

/**
 * One account slot of one instruction. The 'unresolved' variant is the only
 * outcome for an out-of-range index, so index resolution cannot read past the
 * end of the effective key list. Requirement 19.5, 19.6.
 */
export type AccountRef =
  | {
      readonly kind: 'resolved';
      readonly index: number;
      readonly address: Base58Address;
      readonly signer: boolean;
      readonly role: AccountRole;
      readonly origin: AccountOrigin;
      readonly name: string | null;
      readonly confidence: Confidence;
    }
  | {
      readonly kind: 'unresolved';
      readonly index: number;
      /** e.g. loaded addresses unavailable for a v0 message. */
      readonly reason: string;
      readonly confidence: 'raw';
    };

// ---------------------------------------------------------------------------
// Instructions — Requirements 3, 4, 5, 8, 11, 21
// ---------------------------------------------------------------------------

export type DecoderSource = 'anchor-idl' | 'builtin';

/**
 * Raw instruction bytes, preserved whenever decoding is incomplete.
 * Requirements 11.1, 11.5, 11.6.
 */
export interface RawData {
  readonly label: 'raw_instruction_data';
  /** "0x"-prefixed hex; first 256 bytes only when truncated is true. */
  readonly hex: HexString;
  /** True length in bytes, before any truncation. */
  readonly byteLength: number;
  readonly truncated: boolean;
}

/**
 * A decoded parameter value. There is deliberately no f32/f64 variant: an IDL
 * float field decodes to 'unsupported', which forces the instruction to
 * 'partial'. Requirements 9.2, 9.3.
 */
export type DecodedValue =
  | { readonly type: 'bool'; readonly value: boolean }
  | { readonly type: 'u8' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32'; readonly value: number }
  | { readonly type: 'u64' | 'u128' | 'i64' | 'i128'; readonly value: string }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'pubkey'; readonly value: Base58Address }
  | { readonly type: 'bytes'; readonly value: HexString }
  | { readonly type: 'lamports'; readonly value: LamportAmount }
  | { readonly type: 'tokenAmount'; readonly value: TokenAmount }
  | { readonly type: 'unsupported'; readonly idlType: string };

export interface DecodedField {
  readonly name: string;
  readonly value: DecodedValue;
}

/**
 * Outcome of decoding one instruction's data. Confidence is pinned per variant,
 * so no inhabitant can omit it. Requirements 4.5, 11.2, 11.3, 11.7.
 */
export type InstructionDecode =
  | {
      readonly kind: 'full';
      readonly name: string;
      readonly source: DecoderSource;
      readonly fields: readonly DecodedField[];
      readonly confidence: 'full';
    }
  | {
      readonly kind: 'partial';
      readonly name: string;
      readonly source: DecoderSource;
      readonly decodedFields: readonly DecodedField[];
      readonly undecodedData: RawData;
      readonly confidence: 'partial';
    }
  | {
      readonly kind: 'raw';
      readonly name: 'Unknown';
      /** Contains "Unknown program" when no decoder or IDL exists. Req 11.1. */
      readonly note: string;
      readonly rawInstructionData: RawData;
      /** Reason a decoder or IDL lookup failed. Requirement 11.7. */
      readonly errorDetail: string | null;
      readonly confidence: 'raw';
    };

export type ComputeUnits =
  | { readonly available: true; readonly value: number; readonly confidence: 'full' }
  | { readonly available: false; readonly confidence: 'raw' };

/**
 * One log line attached to the instruction that emitted it. Produced by the
 * Phase 2 attributor only; no value of this type is constructed in v1, where
 * the verbatim array on LogReport is the whole of the log output.
 */
export interface AttributedLog {
  /** Position in the original logMessages array. */
  readonly index: number;
  readonly message: string;
  /** Marker-based attribution is never better than partial. Req 21.3. */
  readonly confidence: 'partial';
}

/**
 * One instruction, top-level or nested at any depth. `inner` is recursive with
 * no bound, so an arbitrarily deep CPI chain is representable and nothing is
 * truncated on a depth threshold. Requirement 3.6.
 */
export interface InstructionNode {
  /** Global sequential index in transaction appearance order. Req 3.4. */
  readonly order: number;
  /** 0 for top-level. Requirement 3.3. */
  readonly depth: number;
  /** null for top-level. Requirement 3.3. */
  readonly parentOrder: number | null;
  /** null when the program index could not be resolved. Requirement 3.7. */
  readonly programId: Base58Address | null;
  readonly programName: string | null;
  readonly decode: InstructionDecode;
  readonly accounts: readonly AccountRef[];
  /** True only for the top-level index named by InstructionError. Req 5.2, 5.3. */
  readonly failed: boolean;
  /** False only when the program ID is unresolvable. Requirement 3.7, 3.8. */
  readonly valid: boolean;
  /** Names the unresolved program index when valid is false. Requirement 3.7. */
  readonly invalidReason: string | null;
  /**
   * Populated for top-level nodes in v1 from the depth-1 invoke scopes; the
   * `available: false` variant on nested nodes reflects the Phase 2 per-line
   * attribution deferral, not absent RPC data. Requirement 8.1, 8.2.
   */
  readonly computeUnits: ComputeUnits;
  /** Phase 2 attribution output. Empty on every node in v1. Req 21.2. */
  readonly logs: readonly AttributedLog[];
  readonly inner: readonly InstructionNode[];
  readonly confidence: Confidence;
}

// ---------------------------------------------------------------------------
// Failure and errors — Requirements 5, 6
// ---------------------------------------------------------------------------

export type ErrorNamespace =
  | 'anchor-user'
  | 'anchor-framework'
  | 'system-program'
  | 'spl-token'
  | 'spl-associated-token-account';

export type UnresolvedErrorReason =
  /** Code >= 6000 but no IDL for the failing program. Requirement 6.5. */
  | 'no-idl'
  /** Absent from the table that governs it. Requirement 6.6, 6.10. */
  | 'not-in-table'
  /** Not parseable as an integer. Requirement 6.9. */
  | 'unparseable-code';

export type ResolvedError =
  | {
      readonly kind: 'resolved';
      readonly code: number;
      readonly namespace: ErrorNamespace;
      readonly name: string;
      readonly message: string;
      readonly programId: Base58Address | null;
      readonly confidence: 'full';
    }
  | {
      readonly kind: 'unresolved';
      /** null when the code could not be parsed. Requirement 6.9. */
      readonly code: number | null;
      /** The code as it appeared, e.g. "0x1771". */
      readonly rawCode: string;
      readonly reason: UnresolvedErrorReason;
      readonly programId: Base58Address | null;
      /** No message field exists on this variant, by construction. Req 6.5, 6.6. */
      readonly confidence: 'raw';
    }
  | {
      readonly kind: 'non-custom';
      /** Variant name taken verbatim from the RPC payload. */
      readonly variant: string;
      readonly detail: string | null;
      readonly confidence: 'full';
    };

/** Attribution of a failure to a nested CPI, inferred from logs. Req 5.5. */
export interface CpiAttribution {
  readonly instructionOrder: number;
  readonly programId: Base58Address;
  /** The log lines the attribution rests on. */
  readonly evidence: readonly string[];
  readonly confidence: 'partial';
}

export interface FailureReport {
  /** Top-level index from InstructionError; preserved even if out of range. */
  readonly failingInstructionIndex: number | null;
  /** True when the index exceeds the top-level count. Requirement 5.4. */
  readonly indexOutOfRange: boolean;
  readonly error: ResolvedError;
  readonly cpiAttribution: CpiAttribution | null;
}

// ---------------------------------------------------------------------------
// Balances — Requirements 7.8-7.10, 20
// ---------------------------------------------------------------------------

export type LamportBalanceChange =
  | {
      readonly kind: 'delta';
      readonly accountIndex: number;
      readonly address: Base58Address;
      readonly pre: LamportAmount;
      readonly post: LamportAmount;
      /** post - pre, computed in bigint. Requirement 7.8. */
      readonly delta: LamportAmount;
      readonly confidence: 'full';
    }
  | {
      readonly kind: 'post-only';
      readonly accountIndex: number;
      readonly address: Base58Address;
      readonly post: LamportAmount;
      /** No delta field exists on this variant. Requirement 7.9. */
      readonly confidence: 'partial';
    };

/**
 * A mint's scale. Modelled as a union so a renderer cannot read a number
 * without handling the unknown case, which is what forces base-unit rendering
 * with partial confidence instead of a silently assumed default.
 * Requirements 12.13, 12.14.
 */
export type TokenDecimals =
  | { readonly known: true; readonly value: number }
  | { readonly known: false };

/**
 * A token amount and its scale, inseparable. A renderer receiving one of these
 * always has the decimals needed to format it, or explicit knowledge that it
 * does not. Requirements 20.4, 12.11.
 */
export interface TokenAmount {
  readonly mint: Base58Address;
  readonly raw: RawTokenAmount;
  readonly decimals: TokenDecimals;
}

export type TokenAccountLifecycle = 'existing' | 'created' | 'closed';

export interface TokenBalanceChange {
  readonly accountIndex: number;
  readonly address: Base58Address;
  readonly mint: Base58Address;
  /** null when the account was created by this transaction. Req 20.5. */
  readonly pre: TokenAmount | null;
  /** null when the account was closed by this transaction. Req 20.6. */
  readonly post: TokenAmount | null;
  /** post - pre, or post, or -pre. Requirement 20.3, 20.5, 20.6. */
  readonly delta: TokenAmount;
  readonly lifecycle: TokenAccountLifecycle;
  readonly confidence: Confidence;
}

// ---------------------------------------------------------------------------
// Compute and logs — Requirements 8, 21
// ---------------------------------------------------------------------------

export interface ComputeReport {
  /**
   * Verbatim from metadata. Not the sum of per-instruction values, and not
   * checked against it. Requirement 8.5.
   */
  readonly total: ComputeUnits;
}

export interface LogReport {
  /**
   * meta.logMessages, copied verbatim in RPC order. No parsing is applied and
   * no line is rewritten, reordered, filtered, or marked. Empty when the field
   * was absent. Requirement 21.1.
   */
  readonly messages: readonly string[];
  /** False when logMessages was absent. Requirement 21.6. */
  readonly present: boolean;
  /** Requirement 21.5. */
  readonly truncated: boolean;
  /**
   * Messages that could not be placed by per-line attribution. Empty in v1,
   * where nothing is attributed and `messages` already holds every line; that
   * emptiness is the deferral, not a defect. Requirement 21.4.
   */
  readonly unattributed: readonly string[];
  /**
   * Completeness of the COLLECTION, not of any individual line: `full` when
   * present and not truncated, `partial` when present and truncated
   * (Req 21.5), `raw` when absent (Req 21.6). Property 13 enumerates the log
   * report among the elements that must carry a marker, so the field is not
   * optional. Individual messages carry no marker because a verbatim copy
   * makes no claim that could be partial.
   */
  readonly confidence: Confidence;
}
