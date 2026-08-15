/**
 * Fixture recorder — dev-only maintainer tooling. NOT part of the shipped CLI.
 *
 * It pages `getSignaturesForAddress` for a program address, keeps the entries an
 * explicit outcome filter selects, fetches each with `getTransaction` using
 * `maxSupportedTransactionVersion: 0`, and writes two files per case:
 * `<outDir>/<caseName>/input.json` holding the verbatim RPC response, and
 * `<outDir>/<caseName>/meta.json` recording what the case covers and how it was
 * selected.
 *
 * Four constraints govern this file. Each is deliberate, and the outcome filter
 * changes none of them, because the filter is a predicate over results
 * `getSignaturesForAddress` has already returned — it changes which responses
 * land on disk and nothing about which RPC methods are called.
 *
 * 1. It lives outside `src/`, under `scripts/`. Two reasons. The Requirement 15
 *    read-only AST guard scans `src/`, so keeping the recorder out of that tree
 *    keeps the guard's scope "code we ship" rather than conflating it with code
 *    we run by hand. And the package exclusion then follows from the directory
 *    rather than from anyone remembering: the `files` allowlist in package.json
 *    lists `bin/` and `dist/` only, so `scripts/` is excluded by default and
 *    could only ship if someone explicitly added it.
 *
 * 2. It is the only component permitted to make an unsolicited network call.
 *    Every other network call in Opsis answers a signature the user typed — one
 *    `getTransaction` for one signature. Enumerating candidate transactions is a
 *    search rather than a lookup, which is why this is the sole exception.
 *
 * 3. It is never invoked by the test suite. The suite runs with the task 1.3
 *    network interceptor active and this file would fail there by design.
 *    Recording is a manual maintainer step, run once per fixture, with the
 *    result committed.
 *
 * 4. It performs no transaction construction, no signing, no submission, and no
 *    simulation. `getSignaturesForAddress` and `getTransaction` are both
 *    read-only RPC methods, so the recorder introduces no capability class the
 *    CLI does not already use. It is read-only by inspection: two RPC reads and
 *    two file writes, and nothing else.
 *
 * `--failing-program` and `--custom-error-range` narrow the candidate set
 * further, and `--signature` replaces enumeration with a single direct fetch.
 * None of the three changes the four constraints either: the first two are
 * predicates over a `getTransaction` response already in hand, and the third
 * strictly reduces what is called — one `getTransaction`, no enumeration at all.
 *
 * RATE LIMITING. `--failing-program` and `--custom-error-range` can only be
 * evaluated on a fetched response, so the walk issues one `getTransaction` per
 * candidate that survives `--outcome` and keeps going until one matches. On a
 * hot program most recent failures belong to other programs, so a match can be
 * dozens of fetches in — far past what a public endpoint tolerates. Three things
 * make that survivable: a minimum interval between outbound calls
 * (`--request-interval-ms`), retry with capped exponential backoff on HTTP 429,
 * 502, 503 and 504 honouring `Retry-After` when the endpoint sends one, and
 * periodic progress on stderr so a long walk is visibly working rather than
 * hung. None of it touches the four constraints either: retrying a read is still
 * a read, waiting is not a call, and progress goes to stderr like every other
 * message this script writes.
 *
 * Run by hand, e.g.:
 *
 *   npx tsx scripts/recordFixture.ts \
 *     --program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA \
 *     --case 03-spl-token-error --out-dir tests/golden \
 *     --cluster mainnet-beta --outcome failed --limit 200 \
 *     --recorded-on 2025-01-15 --covers "SPL Token error table selection"
 *
 * or, for a case a maintainer has already found by hand:
 *
 *   npx tsx scripts/recordFixture.ts --signature 3Pyx76... \
 *     --case 07-unknown-program --out-dir tests/golden \
 *     --cluster mainnet-beta --recorded-on 2025-01-15 --covers "..."
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, env, exit, stderr } from 'node:process';

import type { Base58Address, Base58Signature } from '../src/model/analysis.js';

/**
 * Which candidate signatures to keep, judged on the `err` field of the
 * getSignaturesForAddress entry: 'failed' keeps non-null err, 'succeeded' keeps
 * null err, 'any' keeps everything.
 */
export type OutcomeFilter = 'failed' | 'succeeded' | 'any';

/** Cluster names accepted by --cluster and recorded in meta.json. */
export type Cluster = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';

/** Inclusive `min:max` bound on a `Custom` instruction error code. */
export interface CustomErrorRange {
  readonly min: number;
  readonly max: number;
}

/**
 * The two candidate filters that need a fetched `getTransaction` response to
 * evaluate, as opposed to `OutcomeFilter` which reads the enumeration entry.
 *
 * Both members are non-optional and nullable rather than optional, so every
 * construction site states whether it wants the filter. `null` means "not
 * supplied", which is the same as "keep everything".
 */
export interface CandidateFilters {
  /** Keep only candidates whose failing instruction belongs to this program. */
  readonly failingProgram: Base58Address | null;
  /** Keep only candidates whose `Custom` error code lies in this range. */
  readonly customErrorRange: CustomErrorRange | null;
}

/**
 * How hard the recorder is allowed to lean on the endpoint. Shared by both modes
 * because pacing is a property of the connection, not of how candidates are
 * chosen.
 */
export interface RequestPacing {
  /**
   * Minimum wall-clock gap between outbound calls, in milliseconds. 0 disables
   * the throttle entirely, which is the right setting for a dedicated endpoint.
   */
  readonly requestIntervalMs: number;
}

export interface RecordOptions extends CandidateFilters, RequestPacing {
  readonly programAddress: Base58Address;
  readonly rpcUrl: string;
  /** Page size / cap on candidate signatures examined. */
  readonly limit: number;
  /** Destination root, e.g. "tests/golden" or "fixtures". */
  readonly outDir: string;
  /** Directory name for the case, e.g. "02-anchor-user-error". */
  readonly caseName: string;
  readonly cluster: Cluster;
  /** What this case is meant to prove. Written verbatim into meta.json. */
  readonly covers: string;
  /** ISO date, supplied by the caller rather than read from a clock. */
  readonly recordedOn: string;
  /** Explicit, never inferred. 'failed' is the ordinary choice. */
  readonly outcome: OutcomeFilter;
}

/**
 * Options for `--signature` mode: record one curated transaction the maintainer
 * has already identified, with no enumeration and therefore no filters.
 *
 * `rpcUrl` and `cluster` survive from the enumerate options because they are not
 * selection at all — one is how the fetch happens, the other is a fact about the
 * recorded bytes that goes into meta.json.
 */
export interface RecordSignatureOptions extends RequestPacing {
  readonly signature: Base58Signature;
  readonly rpcUrl: string;
  readonly outDir: string;
  readonly caseName: string;
  readonly cluster: Cluster;
  readonly covers: string;
  readonly recordedOn: string;
}

/** Serialized to <outDir>/<caseName>/meta.json. Never read by the pipeline. */
export interface FixtureMeta {
  readonly case: string;
  readonly covers: string;
  readonly cluster: Cluster;
  readonly recordedOn: string;
  readonly signature: Base58Signature;
  /** The filter that selected this case, so it can be re-recorded identically. */
  readonly outcome: OutcomeFilter;
  /**
   * Free text explaining how a case was obtained when that differs from what
   * the case name suggests — for instance a case found by enumerating one
   * program while a different program turned out to be the one that failed.
   *
   * The recorder never writes this field; it is hand-added by the maintainer
   * who knows the provenance, which is why it is optional. A re-recording drops
   * it, so it must be re-added by hand if it still applies.
   */
  readonly recordingNote?: string;
}

export interface RecordedFixture {
  readonly signature: Base58Signature;
  readonly inputPath: string;
  readonly metaPath: string;
}

/**
 * getSignaturesForAddress caps `limit` at 1000 per call, so a larger requested
 * limit is walked as successive pages with a `before` cursor.
 */
const MAX_PAGE_SIZE = 1000;

/**
 * Request timeout for this script only. This is deliberately not the CLI's
 * `ResolvedConfig.requestTimeoutMs`, which is pinned to the literal 10_000 and
 * must stay the single timeout value inside `src/`. The recorder is dev tooling
 * outside that tree and is allowed to wait longer on a paging walk; it must
 * never import the shipped constant, and nothing in `src/` may read this one.
 *
 * This bounds ONE ATTEMPT, not one logical call. Backoff waiting between retries
 * is separate from and additional to it, so a retried call's total elapsed time
 * exceeds this value by design. See `BASE_BACKOFF_MS`.
 */
const RECORDER_TIMEOUT_MS = 30_000;

/**
 * Total attempts for one logical RPC call, the first included. Reaching this cap
 * is a hard failure rather than an endless wait, because a maintainer who is
 * being throttled this persistently needs to hear it and switch endpoints, not
 * watch a script sleep.
 */
const MAX_ATTEMPTS = 6;

/**
 * Exponential backoff base and per-attempt ceiling. The wait these produce is
 * SEPARATE FROM AND ADDITIONAL TO `RECORDER_TIMEOUT_MS`, which remains the
 * per-attempt request timeout: an attempt may take up to RECORDER_TIMEOUT_MS and
 * then be followed by up to MAX_BACKOFF_WAIT_MS of sleeping before the next one
 * starts. Neither budget is deducted from the other.
 */
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_WAIT_MS = 30_000;

/**
 * Extra wait added on top of the exponential term, as a fraction of it, scaled by
 * a caller-supplied random number. Keeps successive walks from retrying in
 * lockstep; small enough that it never dominates the schedule.
 */
const BACKOFF_JITTER_FRACTION = 0.25;

/**
 * Default minimum gap between outbound calls. Chosen for
 * `api.mainnet-beta.solana.com`, which throttles a bare loop within a handful of
 * requests. A maintainer on a dedicated endpoint lowers or zeroes it with
 * `--request-interval-ms`.
 */
const DEFAULT_REQUEST_INTERVAL_MS = 400;

/** How often the walk prints progress, counted in `getTransaction` fetches. */
const PROGRESS_EVERY_FETCHES = 10;

/** Statuses worth retrying: throttling, plus the transient gateway family. */
const RETRYABLE_STATUSES: readonly number[] = [429, 502, 503, 504];

/** Recording failed in a way the maintainer needs to see, not a bug. */
class RecorderError extends Error {}

// --- pure helpers -----------------------------------------------------------

/** Whether an HTTP status is one the recorder will wait and try again on. */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.includes(status);
}

/**
 * `Retry-After` as a delay in milliseconds, or null when the header is absent or
 * unusable.
 *
 * RFC 9110 allows two forms and endpoints send both: `delta-seconds` (a
 * non-negative integer) and an HTTP date. The date form is resolved against the
 * caller-supplied `nowMs` rather than a clock read, which is what keeps this
 * function pure and testable. A date already in the past yields 0 — the endpoint
 * said "now", not "go back in time" — and anything else (a float, a negative, a
 * word, an empty string) yields null so the caller falls back to its own
 * schedule.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  // Checked before parsing: parseInt would accept "1.5" and "12abc" by prefix.
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(seconds)) return null;
    return seconds * 1_000;
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/** Why `backoffDecision` decided what it did. Carried so stderr can say so. */
export type BackoffReason =
  /** The response was not a failure at all; nothing to decide. */
  | 'success'
  /** A failure, but not one retrying could fix — 400, 404, 500 and the rest. */
  | 'not-retryable'
  /** Retryable, but the attempt cap has been reached. */
  | 'attempts-exhausted'
  /** Retryable, and the endpoint told us how long to wait. */
  | 'retry-after'
  /** Retryable, with no usable header, so the exponential schedule applies. */
  | 'backoff';

export interface BackoffDecision {
  readonly retry: boolean;
  /** Milliseconds to sleep before the next attempt. 0 whenever `retry` is false. */
  readonly waitMs: number;
  readonly reason: BackoffReason;
}

/**
 * Inputs to `backoffDecision`. Everything the decision depends on arrives as a
 * value — including the current time and the jitter draw — so the function is
 * pure and can be reasoned about with no network and no clock.
 */
export interface BackoffInput {
  readonly status: number;
  /** The raw `Retry-After` header, or null when the response carried none. */
  readonly retryAfter: string | null | undefined;
  /** 1-based number of the attempt that just produced `status`. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Reference instant for an HTTP-date `Retry-After`. */
  readonly nowMs: number;
  /** Jitter draw in [0, 1], supplied by the caller. 0 makes the result exact. */
  readonly jitter: number;
}

/**
 * Whether to retry a failed RPC attempt and how long to wait first.
 *
 * The whole retry policy lives here, as a total function from a status, a header
 * and an attempt count to a decision. Extracted deliberately: this is the part
 * with the branches worth checking, and none of it needs a socket to check.
 *
 * The per-attempt wait is capped at `MAX_BACKOFF_WAIT_MS` whichever branch
 * produced it, `Retry-After` included — an endpoint asking for ten minutes gets
 * the cap and another attempt rather than a ten-minute stall.
 */
export function backoffDecision(input: BackoffInput): BackoffDecision {
  if (!isRetryableStatus(input.status)) {
    return {
      retry: false,
      waitMs: 0,
      reason: input.status >= 200 && input.status < 400 ? 'success' : 'not-retryable',
    };
  }
  if (input.attempt >= input.maxAttempts) {
    return { retry: false, waitMs: 0, reason: 'attempts-exhausted' };
  }

  const requested = parseRetryAfter(input.retryAfter, input.nowMs);
  if (requested !== null) {
    return { retry: true, waitMs: Math.min(MAX_BACKOFF_WAIT_MS, requested), reason: 'retry-after' };
  }

  const exponential = Math.min(
    MAX_BACKOFF_WAIT_MS,
    BASE_BACKOFF_MS * 2 ** (input.attempt - 1),
  );
  const jitter = Math.min(1, Math.max(0, input.jitter));
  const waitMs = Math.min(
    MAX_BACKOFF_WAIT_MS,
    Math.round(exponential * (1 + BACKOFF_JITTER_FRACTION * jitter)),
  );
  return { retry: true, waitMs, reason: 'backoff' };
}

/**
 * Running counts for one enumerate walk.
 *
 * Mutable, unlike every other type here, because it is a counter the walk bumps
 * as it goes. It exists so the "nothing matched" report can distinguish a filter
 * that is too narrow from a `--limit` that was too low, which is the next thing a
 * maintainer needs to know and cannot recover from a bare failure message.
 */
export interface WalkTally {
  /** Candidates `getSignaturesForAddress` returned and the walk looked at. */
  examined: number;
  /** Candidates the cheap `--outcome` filter dropped without a fetch. */
  outcomeRejected: number;
  /** `getTransaction` calls issued, retries excluded. */
  fetched: number;
  /** Fetches that came back as a JSON-RPC error. */
  rpcErrors: number;
  /** Fetches that came back with a null result. */
  nullResults: number;
  /** Fetched candidates `--failing-program` rejected. */
  failingProgramRejected: number;
  /** Fetched candidates `--custom-error-range` rejected. */
  customErrorRangeRejected: number;
  /** Attempts retried after a throttle or a transient server error. */
  retries: number;
}

export function newWalkTally(): WalkTally {
  return {
    examined: 0,
    outcomeRejected: 0,
    fetched: 0,
    rpcErrors: 0,
    nullResults: 0,
    failingProgramRejected: 0,
    customErrorRangeRejected: 0,
    retries: 0,
  };
}

/**
 * The tally as one line of prose. Pure, so the wording is checkable without a
 * walk. Zero-valued categories are omitted: a filter that was never supplied
 * rejected nothing, and listing it would bury the counts that matter.
 */
export function describeTally(tally: WalkTally): string {
  const parts = [`${tally.examined} candidates examined`, `${tally.fetched} fetched`];
  if (tally.outcomeRejected > 0) {
    parts.push(`${tally.outcomeRejected} rejected by --outcome before fetching`);
  }
  if (tally.failingProgramRejected > 0) {
    parts.push(`${tally.failingProgramRejected} rejected by --failing-program`);
  }
  if (tally.customErrorRangeRejected > 0) {
    parts.push(`${tally.customErrorRangeRejected} rejected by --custom-error-range`);
  }
  if (tally.rpcErrors > 0) parts.push(`${tally.rpcErrors} returned an RPC error`);
  if (tally.nullResults > 0) parts.push(`${tally.nullResults} returned no result`);
  if (tally.retries > 0) parts.push(`${tally.retries} requests retried`);
  return parts.join(', ');
}

/**
 * The outcome filter, as a total predicate over the `err` field of a
 * getSignaturesForAddress entry. `err` is null on success and an object
 * describing the failure otherwise; an absent field is read as null, because
 * absence of an error means the transaction succeeded.
 */
export function selectsOutcome(outcome: OutcomeFilter, err: unknown): boolean {
  const failed = err !== null && err !== undefined;
  switch (outcome) {
    case 'failed':
      return failed;
    case 'succeeded':
      return !failed;
    case 'any':
      return true;
  }
}

/**
 * ---------------------------------------------------------------------------
 * Structural readers over a `getTransaction` result.
 *
 * NOTE ON DELIBERATE DUPLICATION. The three helpers below reimplement a narrow
 * slice of what tasks 4.5 (`src/decode/accountKeys.ts`) and 4.7
 * (`src/decode/instructionTree.ts`) will implement properly: the Requirement
 * 19.3 effective key list ordering, and locating the failing instruction from an
 * `InstructionError` index. The duplication is intentional on both sides of the
 * boundary.
 *
 * The recorder cannot import that code, because it does not exist yet and the
 * recorder is what produces the fixtures those tasks are tested against. And it
 * must never become the pipeline's source of truth: this version answers one
 * yes/no question about a candidate and is allowed to give up on any shape it
 * does not fully understand, whereas the pipeline versions must degrade
 * honestly, mark confidence, and report reasons. When 4.5 and 4.7 land, these
 * stay put — a recorder that imported from `src/` would couple fixture
 * generation to the code the fixtures exist to check.
 * ---------------------------------------------------------------------------
 */

/** A plain JSON object, or null for anything else including arrays and null. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

/** An array of strings, or null when the value is not one. */
function asStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item): item is string => typeof item === 'string')
    ? (value as readonly string[])
    : null;
}

/**
 * The `[index, detail]` pair of an `InstructionError`, or null when `err` is any
 * other error variant.
 *
 * Every other variant — `InsufficientFundsForRent`, `AlreadyProcessed`,
 * `BlockhashNotFound` and the rest — carries no instruction index, so there is
 * no failing instruction to resolve and no `Custom` code to range-check. Both
 * new filters therefore treat those as a skip rather than as an error.
 */
export function instructionErrorEntry(
  err: unknown,
): { readonly index: number; readonly detail: unknown } | null {
  const record = asRecord(err);
  if (record === null) return null;
  const entry = record['InstructionError'];
  if (!Array.isArray(entry) || entry.length < 2) return null;
  const index = entry[0];
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null;
  return { index, detail: entry[1] };
}

/**
 * The effective account key list: static keys, then loaded writable, then loaded
 * readonly. That ordering is Requirement 19.3 and must match what task 4.5
 * implements, so a candidate the recorder accepts is one the pipeline will
 * resolve the same way.
 *
 * Returns null when `accountKeys` or `loadedAddresses` is missing or malformed.
 * A legacy message carries no `loadedAddresses`, so it lands here as null and is
 * skipped: the recorder would rather pass over a candidate it cannot evaluate
 * with certainty than record one on a guess.
 */
export function effectiveAccountKeys(result: unknown): readonly string[] | null {
  const root = asRecord(result);
  if (root === null) return null;
  const message = asRecord(asRecord(root['transaction'])?.['message']);
  const loaded = asRecord(asRecord(root['meta'])?.['loadedAddresses']);
  if (message === null || loaded === null) return null;

  const staticKeys = asStringArray(message['accountKeys']);
  const writable = asStringArray(loaded['writable']);
  const readonlyKeys = asStringArray(loaded['readonly']);
  if (staticKeys === null || writable === null || readonlyKeys === null) return null;

  return [...staticKeys, ...writable, ...readonlyKeys];
}

/**
 * The address of the program owning the failing instruction, or null when that
 * cannot be determined from the response.
 *
 * Null covers every shape the recorder declines to guess at: a non-
 * `InstructionError` error, a missing `instructions` array, an instruction index
 * past the end of it, a missing or non-integer `programIdIndex`, and a
 * `programIdIndex` past the end of the effective key list. `noUncheckedIndexedAccess`
 * makes each of those a compile-time obligation rather than an oversight.
 */
export function failingProgramAddress(result: unknown): Base58Address | null {
  const entry = instructionErrorEntry(asRecord(asRecord(result)?.['meta'])?.['err']);
  if (entry === null) return null;

  const message = asRecord(asRecord(asRecord(result)?.['transaction'])?.['message']);
  const instructions = message?.['instructions'];
  if (!Array.isArray(instructions)) return null;

  const instruction = asRecord(instructions[entry.index]);
  if (instruction === null) return null;

  const programIdIndex = instruction['programIdIndex'];
  if (typeof programIdIndex !== 'number' || !Number.isInteger(programIdIndex)) return null;
  if (programIdIndex < 0) return null;

  const keys = effectiveAccountKeys(result);
  if (keys === null) return null;

  return keys[programIdIndex] ?? null;
}

/**
 * Whether the failing instruction belongs to `programAddress`.
 *
 * A candidate whose failing program cannot be resolved is not a match, so this
 * is total: it never throws and never treats "unknown" as "yes".
 */
export function selectsFailingProgram(programAddress: Base58Address, result: unknown): boolean {
  return failingProgramAddress(result) === programAddress;
}

/**
 * The `Custom` error code carried by an `InstructionError`, or null for every
 * other shape — including a non-`Custom` `InstructionError` variant such as the
 * bare string `"ProgramFailedToComplete"` or `{ BorshIoError: "..." }`.
 */
export function customErrorCode(result: unknown): number | null {
  const entry = instructionErrorEntry(asRecord(asRecord(result)?.['meta'])?.['err']);
  if (entry === null) return null;
  const detail = asRecord(entry.detail);
  if (detail === null) return null;
  const code = detail['Custom'];
  return typeof code === 'number' && Number.isInteger(code) ? code : null;
}

/**
 * Whether the candidate's `Custom` error code lies inside the inclusive range.
 *
 * Why this filter exists at all: an Anchor framework error is identified purely
 * by its code falling in 2000-5999. That is a property of the code, not of the
 * program that raised it — any Anchor program can raise one — so no
 * program-address filter can find such a case. Hunting `04-anchor-framework-error`
 * by enumerating programs and eyeballing codes is exactly the manual work this
 * replaces.
 */
export function selectsCustomErrorRange(range: CustomErrorRange, result: unknown): boolean {
  const code = customErrorCode(result);
  return code !== null && code >= range.min && code <= range.max;
}

/** Which response-level filter turned a candidate away, if any did. */
export type CandidateRejection = 'failing-program' | 'custom-error-range' | null;

/**
 * The first response-level filter to reject the candidate, or null when every
 * supplied filter accepted it.
 *
 * Named for the rejecting filter rather than returning a bare boolean so the walk
 * can tally rejections per filter. Order matters only for the tally, never for
 * the verdict: the filters are conjunctive, so any rejection is the answer.
 */
export function candidateRejection(
  filters: CandidateFilters,
  result: unknown,
): CandidateRejection {
  if (filters.failingProgram !== null && !selectsFailingProgram(filters.failingProgram, result)) {
    return 'failing-program';
  }
  if (
    filters.customErrorRange !== null &&
    !selectsCustomErrorRange(filters.customErrorRange, result)
  ) {
    return 'custom-error-range';
  }
  return null;
}

/**
 * The two response-level filters, applied conjunctively: a candidate must
 * satisfy every filter that was supplied. An unsupplied filter (`null`) keeps
 * everything, so `{ failingProgram: null, customErrorRange: null }` is the
 * identity.
 */
export function selectsCandidate(filters: CandidateFilters, result: unknown): boolean {
  return candidateRejection(filters, result) === null;
}

/**
 * The outcome a fetched response actually exhibits, or null when `meta` is
 * absent and there is nothing to observe.
 *
 * Used only by `--signature` mode, where no outcome filter was applied and so
 * `FixtureMeta.outcome` cannot report one. Recording what was observed instead
 * keeps meta.json honest about how the case was obtained while leaving it
 * re-recordable: re-running with this outcome as a filter over the same
 * signature would select the same transaction.
 */
export function observedOutcome(result: unknown): 'failed' | 'succeeded' | null {
  const meta = asRecord(asRecord(result)?.['meta']);
  if (meta === null) return null;
  const err = meta['err'];
  return err !== null && err !== undefined ? 'failed' : 'succeeded';
}

/** Parses `--custom-error-range min:max`. Throws on anything malformed. */
export function parseCustomErrorRange(value: string): CustomErrorRange {
  const parts = value.split(':');
  if (parts.length !== 2) {
    throw new RecorderError(`--custom-error-range must be <min>:<max>, got ${value}`);
  }
  const [rawMin, rawMax] = parts;
  if (rawMin === undefined || rawMax === undefined) {
    throw new RecorderError(`--custom-error-range must be <min>:<max>, got ${value}`);
  }
  // Rejects "1.5", "0x10", "12abc" and "" alike: parseInt would accept the last
  // three by prefix, so the source text is checked before it is trusted.
  const INTEGER = /^-?\d+$/u;
  if (!INTEGER.test(rawMin) || !INTEGER.test(rawMax)) {
    throw new RecorderError(`--custom-error-range bounds must be integers, got ${value}`);
  }
  const min = Number.parseInt(rawMin, 10);
  const max = Number.parseInt(rawMax, 10);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
    throw new RecorderError(`--custom-error-range bounds are out of range, got ${value}`);
  }
  if (min > max) {
    throw new RecorderError(`--custom-error-range min must not exceed max, got ${value}`);
  }
  return { min, max };
}

export interface FixturePaths {
  readonly dir: string;
  readonly inputPath: string;
  readonly metaPath: string;
}

/** `<outDir>/<caseName>/{input,meta}.json`. The only place these names appear. */
export function fixturePaths(outDir: string, caseName: string): FixturePaths {
  const dir = join(outDir, caseName);
  return {
    dir,
    inputPath: join(dir, 'input.json'),
    metaPath: join(dir, 'meta.json'),
  };
}

const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_CR = 0x0d;
const CH_SPACE = 0x20;
const CH_QUOTE = 0x22;
const CH_COMMA = 0x2c;
const CH_COLON = 0x3a;
const CH_BACKSLASH = 0x5c;
const CH_LBRACKET = 0x5b;
const CH_RBRACKET = 0x5d;
const CH_LBRACE = 0x7b;
const CH_RBRACE = 0x7d;

function isWhitespace(code: number): boolean {
  return code === CH_SPACE || code === CH_TAB || code === CH_LF || code === CH_CR;
}

function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && isWhitespace(text.charCodeAt(i))) i += 1;
  return i;
}

/** `from` points at the opening quote. Returns the index just past the close. */
function scanString(text: string, from: number): number {
  let i = from + 1;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === CH_BACKSLASH) {
      i += 2;
      continue;
    }
    if (code === CH_QUOTE) return i + 1;
    i += 1;
  }
  throw new RecorderError('unterminated string in RPC response body');
}

/** Returns the index just past the JSON value beginning at `from`. */
function scanValue(text: string, from: number): number {
  const code = text.charCodeAt(from);
  if (code === CH_QUOTE) return scanString(text, from);
  if (code === CH_LBRACE || code === CH_LBRACKET) {
    // Depth walk. Strings are skipped whole, so a brace inside a string
    // cannot unbalance the count.
    let depth = 0;
    let i = from;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === CH_QUOTE) {
        i = scanString(text, i);
        continue;
      }
      if (c === CH_LBRACE || c === CH_LBRACKET) depth += 1;
      else if (c === CH_RBRACE || c === CH_RBRACKET) {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    throw new RecorderError('unterminated object or array in RPC response body');
  }
  // Number, true, false, or null: runs to the next structural delimiter.
  let i = from;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (isWhitespace(c) || c === CH_COMMA || c === CH_RBRACE || c === CH_RBRACKET) break;
    i += 1;
  }
  if (i === from) throw new RecorderError('expected a JSON value in RPC response body');
  return i;
}

/**
 * Returns the exact source text of a top-level member of a JSON object, or null
 * when the member is absent.
 *
 * This slices bytes rather than round-tripping through `JSON.parse` +
 * `JSON.stringify`, so what the endpoint sent is what lands in `input.json`:
 * key order, spacing, and integer literals are all preserved. That matters
 * because a `u64` lamport balance can exceed 2^53, and a re-serializing
 * recorder would silently round it before the fixture was ever committed.
 */
export function extractRawMember(text: string, key: string): string | null {
  let i = skipWhitespace(text, 0);
  if (text.charCodeAt(i) !== CH_LBRACE) {
    throw new RecorderError('RPC response body is not a JSON object');
  }
  i += 1;
  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) {
      throw new RecorderError('unterminated object in RPC response body');
    }
    const code = text.charCodeAt(i);
    if (code === CH_RBRACE) return null;
    if (code === CH_COMMA) {
      i += 1;
      continue;
    }
    if (code !== CH_QUOTE) {
      throw new RecorderError('malformed member name in RPC response body');
    }
    const keyEnd = scanString(text, i);
    const memberName = JSON.parse(text.slice(i, keyEnd)) as string;
    i = skipWhitespace(text, keyEnd);
    if (text.charCodeAt(i) !== CH_COLON) {
      throw new RecorderError('missing ":" after member name in RPC response body');
    }
    i = skipWhitespace(text, i + 1);
    const valueEnd = scanValue(text, i);
    if (memberName === key) return text.slice(i, valueEnd);
    i = valueEnd;
  }
}

// --- RPC --------------------------------------------------------------------

function warn(message: string): void {
  stderr.write(`recordFixture: ${message}\n`);
}

/**
 * Dependency-free sleep. A bare promise around `setTimeout` rather than
 * `node:timers/promises` or a package, so the recorder keeps needing nothing
 * installed to run.
 */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * When the last outbound call left. Module-level because the throttle is a
 * property of the process's relationship with the endpoint, not of any one call
 * site: enumeration pages and candidate fetches share one budget, which is the
 * only way a single gap between requests can mean anything.
 */
let lastRequestAtMs = 0;

/** Waits out the remainder of the minimum inter-request gap, if any. */
async function pace(intervalMs: number): Promise<void> {
  if (intervalMs > 0) {
    const waitMs = lastRequestAtMs + intervalMs - Date.now();
    if (waitMs > 0) await sleep(waitMs);
  }
  lastRequestAtMs = Date.now();
}

/** Everything a call needs beyond its method and params. */
interface RequestContext extends RequestPacing {
  readonly rpcUrl: string;
  /** Bumped on every retry when present. Null in `--signature` mode. */
  readonly tally: WalkTally | null;
}

/**
 * The connection-shaped part of either options record, plus the walk's tally when
 * there is one. Both modes reach the same `rpcCall` this way, so pacing and retry
 * behave identically whether a candidate was enumerated or named outright.
 */
function requestContext(
  options: RequestPacing & { readonly rpcUrl: string },
  tally: WalkTally | null,
): RequestContext {
  return { rpcUrl: options.rpcUrl, requestIntervalMs: options.requestIntervalMs, tally };
}

/**
 * Returns the raw response body text. Read-only calls only.
 *
 * Retries throttling and transient gateway failures with capped exponential
 * backoff, honouring `Retry-After`. `RECORDER_TIMEOUT_MS` bounds each individual
 * attempt; the backoff wait sits between attempts and is additional to it, so
 * total elapsed time for one logical call can exceed the timeout by design.
 */
async function rpcCall(
  context: RequestContext,
  method: 'getSignaturesForAddress' | 'getTransaction',
  params: readonly unknown[],
): Promise<string> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

  for (let attempt = 1; ; attempt += 1) {
    await pace(context.requestIntervalMs);
    const response = await fetch(context.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(RECORDER_TIMEOUT_MS),
    });
    if (response.ok) return await response.text();

    const retryAfter = response.headers.get('retry-after');
    const decision = backoffDecision({
      status: response.status,
      retryAfter,
      attempt,
      maxAttempts: MAX_ATTEMPTS,
      nowMs: Date.now(),
      jitter: Math.random(),
    });
    const status = `HTTP ${response.status} ${response.statusText}`.trimEnd();

    if (!decision.retry) {
      if (decision.reason === 'attempts-exhausted') {
        throw new RecorderError(
          `${method} returned ${status} on all ${MAX_ATTEMPTS} attempts; the endpoint is ` +
            'rate-limiting this walk. Supply a dedicated endpoint with --rpc-url, or raise ' +
            '--request-interval-ms to slow the walk down',
        );
      }
      throw new RecorderError(`${method} returned ${status}`);
    }

    if (context.tally !== null) context.tally.retries += 1;
    const because =
      decision.reason === 'retry-after' ? ` (Retry-After: ${retryAfter ?? ''})` : '';
    warn(
      `${method} returned ${status}${because}; waiting ${decision.waitMs}ms then retrying, ` +
        `attempt ${attempt + 1} of ${MAX_ATTEMPTS}`,
    );
    await sleep(decision.waitMs);
  }
}

/** The JSON-RPC `error` member as source text, or null when the call succeeded. */
function rpcError(body: string): string | null {
  const raw = extractRawMember(body, 'error');
  return raw === null || raw === 'null' ? null : raw;
}

interface SignatureEntry {
  readonly signature: Base58Signature;
  readonly err: unknown;
}

/**
 * Walks candidate signatures newest-first, at most `limit` of them, in pages of
 * at most 1000. `limit` is both the page size and the cap on how many
 * candidates are examined, so the common case of `limit <= 1000` is one call.
 */
async function* candidateSignatures(
  options: RecordOptions,
  context: RequestContext,
): AsyncGenerator<SignatureEntry, void, void> {
  let examined = 0;
  let before: Base58Signature | undefined;
  while (examined < options.limit) {
    const pageSize = Math.min(MAX_PAGE_SIZE, options.limit - examined);
    const config =
      before === undefined
        ? { limit: pageSize, commitment: 'finalized' }
        : { limit: pageSize, commitment: 'finalized', before };
    const body = await rpcCall(context, 'getSignaturesForAddress', [
      options.programAddress,
      config,
    ]);
    const failure = rpcError(body);
    if (failure !== null) {
      throw new RecorderError(`getSignaturesForAddress failed: ${failure}`);
    }
    // Only `signature` and `err` are read here, both small values, so a parse
    // is safe. The verbatim-bytes concern applies to `input.json` alone.
    const entries = JSON.parse(body).result as readonly SignatureEntry[] | null;
    if (entries === null || entries.length === 0) return;
    for (const entry of entries) {
      examined += 1;
      yield entry;
    }
    if (entries.length < pageSize) return;
    const last = entries[entries.length - 1];
    if (last === undefined) return;
    before = last.signature;
  }
}

// --- recording --------------------------------------------------------------

/**
 * Records one fixture case.
 *
 * Returns a single-element array for the case that was written, or an empty
 * array when no candidate in the examined window matched. One invocation
 * produces one case directory, since `caseName` names one directory and
 * `FixtureMeta` carries one signature; task 2.2 invokes this once per case.
 * Candidates are fetched in order and the first one that yields a usable
 * response wins — a candidate whose `getTransaction` returns an error or a null
 * result is reported and skipped rather than aborting the walk, and so is one
 * the `CandidateFilters` reject.
 *
 * `tally` is optional and defaults to a fresh counter, so the design.md call
 * form `recordTransactions(options)` still holds. A caller that passes one in
 * owns it and can read the counts afterwards, which is how the "nothing matched"
 * report says what the walk actually did.
 */
export async function recordTransactions(
  options: RecordOptions,
  tally: WalkTally = newWalkTally(),
): Promise<readonly RecordedFixture[]> {
  const { dir, inputPath, metaPath } = fixturePaths(options.outDir, options.caseName);
  const context = requestContext(options, tally);

  for await (const entry of candidateSignatures(options, context)) {
    tally.examined += 1;
    if (!selectsOutcome(options.outcome, entry.err)) {
      tally.outcomeRejected += 1;
      continue;
    }

    // `encoding` is left unset so the endpoint applies its default, which is
    // exactly what RpcSource's web3.js call sends. The recorded bytes are then
    // the same shape a live run receives, which is what Property 6 rests on.
    const body = await rpcCall(context, 'getTransaction', [
      entry.signature,
      { commitment: 'finalized', maxSupportedTransactionVersion: 0 },
    ]);
    tally.fetched += 1;
    // Periodic rather than per-candidate: a walk of hundreds is the case this
    // exists for, and a line per fetch would bury the retry notices.
    if (tally.fetched % PROGRESS_EVERY_FETCHES === 0) {
      warn(`still searching — ${describeTally(tally)}`);
    }

    const failure = rpcError(body);
    if (failure !== null) {
      tally.rpcErrors += 1;
      warn(`getTransaction failed for ${entry.signature}, skipping: ${failure}`);
      continue;
    }

    const result = extractRawMember(body, 'result');
    if (result === null || result === 'null') {
      tally.nullResults += 1;
      warn(`getTransaction returned no result for ${entry.signature}, skipping`);
      continue;
    }

    // The response-level filters need the parsed shape. Parsing here is safe
    // because nothing parsed is ever written: `input.json` gets `result`, the
    // untouched source text, so u64 precision is preserved regardless.
    const rejection = candidateRejection(options, JSON.parse(result));
    if (rejection === 'failing-program') {
      tally.failingProgramRejected += 1;
      continue;
    }
    if (rejection === 'custom-error-range') {
      tally.customErrorRangeRejected += 1;
      continue;
    }

    await mkdir(dir, { recursive: true });
    // Written byte-for-byte as received: no trailing newline, no reformatting,
    // no re-keying. FixtureSource reads this file as the RPC response.
    await writeFile(inputPath, result, 'utf8');

    const meta: FixtureMeta = {
      case: options.caseName,
      covers: options.covers,
      cluster: options.cluster,
      recordedOn: options.recordedOn,
      signature: entry.signature,
      outcome: options.outcome,
    };
    // meta.json is ours to format; nothing reads it, so it is pretty-printed
    // for the next maintainer.
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    return [{ signature: entry.signature, inputPath, metaPath }];
  }

  return [];
}

/**
 * Records one curated transaction the maintainer already identified, bypassing
 * enumeration entirely: exactly one `getTransaction`, no
 * `getSignaturesForAddress` call at all.
 *
 * There is no next candidate to fall through to here, so a not-found signature
 * or a null result is a hard failure rather than a skip — the maintainer named a
 * specific transaction and silently recording nothing would be worse than
 * stopping.
 */
export async function recordSignature(
  options: RecordSignatureOptions,
): Promise<RecordedFixture> {
  const { dir, inputPath, metaPath } = fixturePaths(options.outDir, options.caseName);

  // No walk, so no tally: there is exactly one candidate and nothing to count.
  const body = await rpcCall(requestContext(options, null), 'getTransaction', [
    options.signature,
    { commitment: 'finalized', maxSupportedTransactionVersion: 0 },
  ]);

  const failure = rpcError(body);
  if (failure !== null) {
    throw new RecorderError(`getTransaction failed for ${options.signature}: ${failure}`);
  }

  const result = extractRawMember(body, 'result');
  if (result === null || result === 'null') {
    throw new RecorderError(
      `getTransaction found no transaction for ${options.signature}; ` +
        'check the signature and that the cluster and --rpc-url agree',
    );
  }

  // No filter ran, so meta.json records the outcome the response exhibits.
  const outcome = observedOutcome(JSON.parse(result));
  if (outcome === null) {
    throw new RecorderError(
      `getTransaction returned a result with no meta for ${options.signature}, ` +
        'so its outcome cannot be recorded honestly',
    );
  }

  await mkdir(dir, { recursive: true });
  await writeFile(inputPath, result, 'utf8');

  const meta: FixtureMeta = {
    case: options.caseName,
    covers: options.covers,
    cluster: options.cluster,
    recordedOn: options.recordedOn,
    signature: options.signature,
    outcome,
  };
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  return { signature: options.signature, inputPath, metaPath };
}

// --- CLI entry point --------------------------------------------------------

const CLUSTERS = ['mainnet-beta', 'devnet', 'testnet', 'localnet'] as const;
const OUTCOMES = ['failed', 'succeeded', 'any'] as const;

/** Endpoint used when neither `--rpc-url` nor `OPSIS_RPC_URL` supplies one. */
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

/** Environment variable read as the middle term of the endpoint precedence. */
const RPC_URL_ENV_VAR = 'OPSIS_RPC_URL';

const USAGE = `Usage: recordFixture.ts [options]

Enumerate mode (default):

  --program <base58>     Program address to enumerate (required)
  --outcome <filter>     failed | succeeded | any (required, never defaulted)
  --limit <n>            Candidate signatures to examine (default: 100)

  --failing-program <base58>
                         Keep a candidate only when its failing instruction
                         belongs to this program. Requires an InstructionError;
                         any other error variant is skipped, as is any response
                         whose failing instruction cannot be resolved
  --custom-error-range <min>:<max>
                         Keep a candidate only when its InstructionError payload
                         is Custom with a code in this inclusive range. Use
                         2000:5999 to find an Anchor framework error, which no
                         program-address filter can locate

  --failing-program and --custom-error-range compose: supply both and a candidate
  must satisfy both. Either may also be combined with --outcome, which is applied
  first because it reads the enumeration entry rather than the fetched response.

Signature mode:

  --signature <base58>   Record exactly this transaction with one getTransaction
                         and no enumeration. --program, --outcome, --limit,
                         --failing-program and --custom-error-range are ignored,
                         and supplying any of them warns on stderr.
                         --rpc-url and --cluster still apply: one is how the
                         fetch happens, the other is recorded in meta.json.
                         meta.json's outcome records the observed outcome, since
                         no filter was applied

Both modes:

  --case <name>          Case directory name, e.g. 02-anchor-user-error (required)
  --covers <text>        What the case proves (required)
  --recorded-on <date>   ISO date, e.g. 2025-01-15 (required)
  --out-dir <path>       Destination root (default: tests/golden)
  --cluster <name>       ${CLUSTERS.join(' | ')} (default: mainnet-beta)
  --rpc-url <url>        RPC endpoint. Precedence: --rpc-url, then ${RPC_URL_ENV_VAR},
                         then ${DEFAULT_RPC_URL}. Prefer
                         ${RPC_URL_ENV_VAR} for a credentialed endpoint: a flag
                         value lands in shell history and in ps output
  --request-interval-ms <n>
                         Minimum gap between outbound RPC calls, in milliseconds
                         (default: ${DEFAULT_REQUEST_INTERVAL_MS}). 0 disables the throttle. The default
                         suits the public endpoint; lower it on a dedicated one.
                         Throttling and transient 5xx replies are retried with
                         capped exponential backoff regardless of this setting,
                         honouring Retry-After when the endpoint sends one
`;

/** Flags that select candidates, and so mean nothing in `--signature` mode. */
const SELECTION_FLAGS = [
  'program',
  'outcome',
  'limit',
  'failing-program',
  'custom-error-range',
] as const;

/**
 * What one invocation asked for. A discriminated union rather than one widened
 * options record, because the two modes genuinely require different fields:
 * `--program` and `--outcome` are mandatory for enumeration and meaningless for
 * a direct fetch.
 */
export type RecorderInvocation =
  | { readonly mode: 'enumerate'; readonly options: RecordOptions }
  | {
      readonly mode: 'signature';
      readonly options: RecordSignatureOptions;
      /**
       * Selection flags that were supplied but will not be applied. Returned
       * rather than warned about here so `parseArgs` stays pure; `main` prints
       * them, so a maintainer who passes a filter that is being dropped finds
       * out immediately instead of believing it was honoured.
       */
      readonly ignoredFlags: readonly string[];
    };

/**
 * The endpoint for this invocation: `--rpc-url` > `OPSIS_RPC_URL` >
 * `DEFAULT_RPC_URL`. Both inputs arrive as values rather than being read here, so
 * the precedence is checkable without touching the real environment. An empty
 * string counts as absent in both positions, matching how `required()` treats an
 * empty flag value — `OPSIS_RPC_URL=` is an unset variable, not a request to POST
 * to nowhere.
 *
 * Two reasons the environment variable is honoured at all.
 *
 * 1. IT MIRRORS THE SHIPPED CLI. `src/config.ts` resolves the endpoint with
 *    exactly this precedence per Requirement 16.1-16.4. A maintainer who has
 *    already exported the variable for `opsis` would find a dev tool that ignored
 *    it gratuitously inconsistent, and the inconsistency would show up as a
 *    recording silently going to the public endpoint.
 *
 * 2. IT KEEPS A CREDENTIALED ENDPOINT OFF THE COMMAND LINE. A paid endpoint
 *    usually carries its API key in the URL. Passed as `--rpc-url` that key is
 *    written to shell history and to the process argument list, where any local
 *    process can read it out of `ps`; read from the environment it is in neither.
 *    The recorded fixture cannot leak it either — the recorder never writes the
 *    endpoint into meta.json, which records the cluster name only — and nothing
 *    in this script prints the resolved value.
 */
export function resolveRpcUrl(
  flagValue: string | undefined,
  envValue: string | undefined,
): string {
  if (flagValue !== undefined && flagValue !== '') return flagValue;
  if (envValue !== undefined && envValue !== '') return envValue;
  return DEFAULT_RPC_URL;
}

/**
 * Minimal `--flag value` parse. Hand-rolled rather than commander because this
 * file never ships and the flag set is fixed.
 *
 * `rpcUrlEnv` defaults to `OPSIS_RPC_URL` from the process environment so `main`
 * needs no extra argument, and is a parameter so a caller can supply the value
 * and keep the parse pure — the same shape as `resolveConfig(options, env)` in
 * the shipped CLI.
 */
export function parseArgs(
  args: readonly string[],
  rpcUrlEnv: string | undefined = env[RPC_URL_ENV_VAR],
): RecorderInvocation {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) throw new RecorderError(`unexpected argument: ${arg}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new RecorderError(`missing value for ${arg}`);
    }
    flags.set(arg.slice(2), value);
    i += 1;
  }

  const required = (name: string): string => {
    const value = flags.get(name);
    if (value === undefined || value === '') throw new RecorderError(`missing required --${name}`);
    return value;
  };

  const cluster = flags.get('cluster') ?? 'mainnet-beta';
  if (!(CLUSTERS as readonly string[]).includes(cluster)) {
    throw new RecorderError(`--cluster must be one of ${CLUSTERS.join(', ')}`);
  }

  const rawInterval = flags.get('request-interval-ms') ?? String(DEFAULT_REQUEST_INTERVAL_MS);
  // 0 is allowed and means "no throttle"; negative is not, since it would read as
  // a request to go faster than "immediately".
  if (!/^\d+$/u.test(rawInterval)) {
    throw new RecorderError(
      `--request-interval-ms must be a non-negative integer, got ${rawInterval}`,
    );
  }
  const requestIntervalMs = Number.parseInt(rawInterval, 10);
  if (!Number.isSafeInteger(requestIntervalMs)) {
    throw new RecorderError(`--request-interval-ms is out of range, got ${rawInterval}`);
  }

  const common = {
    rpcUrl: resolveRpcUrl(flags.get('rpc-url'), rpcUrlEnv),
    outDir: flags.get('out-dir') ?? 'tests/golden',
    caseName: required('case'),
    cluster: cluster as Cluster,
    covers: required('covers'),
    recordedOn: required('recorded-on'),
    requestIntervalMs,
  } as const;

  const signature = flags.get('signature');
  if (signature !== undefined && signature !== '') {
    return {
      mode: 'signature',
      options: { ...common, signature },
      ignoredFlags: SELECTION_FLAGS.filter((name) => flags.has(name)),
    };
  }

  const outcome = required('outcome');
  if (!(OUTCOMES as readonly string[]).includes(outcome)) {
    throw new RecorderError(`--outcome must be one of ${OUTCOMES.join(', ')}`);
  }

  const rawLimit = flags.get('limit') ?? '100';
  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RecorderError(`--limit must be a positive integer, got ${rawLimit}`);
  }

  const rawRange = flags.get('custom-error-range');

  return {
    mode: 'enumerate',
    options: {
      ...common,
      programAddress: required('program'),
      limit,
      outcome: outcome as OutcomeFilter,
      failingProgram: flags.get('failing-program') ?? null,
      customErrorRange: rawRange === undefined ? null : parseCustomErrorRange(rawRange),
    },
  };
}

/** Human-readable description of the filters, for the "nothing matched" report. */
function describeFilters(options: RecordOptions): string {
  const parts = [`outcome ${options.outcome}`];
  if (options.failingProgram !== null) {
    parts.push(`failing program ${options.failingProgram}`);
  }
  if (options.customErrorRange !== null) {
    parts.push(
      `custom error in ${options.customErrorRange.min}:${options.customErrorRange.max}`,
    );
  }
  return parts.join(', ');
}

async function main(args: readonly string[]): Promise<number> {
  let invocation: RecorderInvocation;
  try {
    invocation = parseArgs(args);
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    stderr.write(USAGE);
    return 2;
  }

  try {
    if (invocation.mode === 'signature') {
      for (const name of invocation.ignoredFlags) {
        warn(`--${name} is ignored in --signature mode and was not applied`);
      }
      const fixture = await recordSignature(invocation.options);
      warn(`recorded ${fixture.signature} -> ${fixture.inputPath}, ${fixture.metaPath}`);
      return 0;
    }

    const { options } = invocation;
    // Owned here rather than inside the walk so the counts survive a walk that
    // found nothing, which is exactly when they are worth reading.
    const tally = newWalkTally();
    const recorded = await recordTransactions(options, tally);
    const fixture = recorded[0];
    if (fixture === undefined) {
      warn(
        `no transaction matching ${describeFilters(options)} found for ` +
          `${options.programAddress} in the first ${options.limit} signatures`,
      );
      // Which filter did the rejecting separates "too narrow" from "--limit too
      // low", and those want opposite next moves.
      warn(describeTally(tally));
      return 1;
    }
    warn(`recorded ${fixture.signature} -> ${fixture.inputPath}, ${fixture.metaPath}`);
    return 0;
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// Runs only when this file is the process entry point, so importing it (for the
// pure helpers) never opens a socket.
if (import.meta.url === `file://${argv[1] ?? ''}`) {
  exit(await main(argv.slice(2)));
}
