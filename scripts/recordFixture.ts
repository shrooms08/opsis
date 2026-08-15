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
 * Run by hand, e.g.:
 *
 *   npx tsx scripts/recordFixture.ts \
 *     --program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA \
 *     --case 03-spl-token-error --out-dir tests/golden \
 *     --cluster mainnet-beta --outcome failed --limit 200 \
 *     --recorded-on 2025-01-15 --covers "SPL Token error table selection"
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, exit, stderr } from 'node:process';

import type { Base58Address, Base58Signature } from '../src/model/analysis.js';

/**
 * Which candidate signatures to keep, judged on the `err` field of the
 * getSignaturesForAddress entry: 'failed' keeps non-null err, 'succeeded' keeps
 * null err, 'any' keeps everything.
 */
export type OutcomeFilter = 'failed' | 'succeeded' | 'any';

export interface RecordOptions {
  readonly programAddress: Base58Address;
  readonly rpcUrl: string;
  /** Page size / cap on candidate signatures examined. */
  readonly limit: number;
  /** Destination root, e.g. "tests/golden" or "fixtures". */
  readonly outDir: string;
  /** Directory name for the case, e.g. "02-anchor-user-error". */
  readonly caseName: string;
  readonly cluster: 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
  /** What this case is meant to prove. Written verbatim into meta.json. */
  readonly covers: string;
  /** ISO date, supplied by the caller rather than read from a clock. */
  readonly recordedOn: string;
  /** Explicit, never inferred. 'failed' is the ordinary choice. */
  readonly outcome: OutcomeFilter;
}

/** Serialized to <outDir>/<caseName>/meta.json. Never read by the pipeline. */
export interface FixtureMeta {
  readonly case: string;
  readonly covers: string;
  readonly cluster: RecordOptions['cluster'];
  readonly recordedOn: string;
  readonly signature: Base58Signature;
  /** The filter that selected this case, so it can be re-recorded identically. */
  readonly outcome: OutcomeFilter;
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
 */
const RECORDER_TIMEOUT_MS = 30_000;

/** Recording failed in a way the maintainer needs to see, not a bug. */
class RecorderError extends Error {}

// --- pure helpers -----------------------------------------------------------

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

/** Returns the raw response body text. Read-only calls only. */
async function rpcCall(
  rpcUrl: string,
  method: 'getSignaturesForAddress' | 'getTransaction',
  params: readonly unknown[],
): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(RECORDER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new RecorderError(`${method} returned HTTP ${response.status} ${response.statusText}`);
  }
  return await response.text();
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

function warn(message: string): void {
  stderr.write(`recordFixture: ${message}\n`);
}

/**
 * Walks candidate signatures newest-first, at most `limit` of them, in pages of
 * at most 1000. `limit` is both the page size and the cap on how many
 * candidates are examined, so the common case of `limit <= 1000` is one call.
 */
async function* candidateSignatures(
  options: RecordOptions,
): AsyncGenerator<SignatureEntry, void, void> {
  let examined = 0;
  let before: Base58Signature | undefined;
  while (examined < options.limit) {
    const pageSize = Math.min(MAX_PAGE_SIZE, options.limit - examined);
    const config =
      before === undefined
        ? { limit: pageSize, commitment: 'finalized' }
        : { limit: pageSize, commitment: 'finalized', before };
    const body = await rpcCall(options.rpcUrl, 'getSignaturesForAddress', [
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
 * result is reported and skipped rather than aborting the walk.
 */
export async function recordTransactions(
  options: RecordOptions,
): Promise<readonly RecordedFixture[]> {
  const { dir, inputPath, metaPath } = fixturePaths(options.outDir, options.caseName);

  for await (const entry of candidateSignatures(options)) {
    if (!selectsOutcome(options.outcome, entry.err)) continue;

    // `encoding` is left unset so the endpoint applies its default, which is
    // exactly what RpcSource's web3.js call sends. The recorded bytes are then
    // the same shape a live run receives, which is what Property 6 rests on.
    const body = await rpcCall(options.rpcUrl, 'getTransaction', [
      entry.signature,
      { commitment: 'finalized', maxSupportedTransactionVersion: 0 },
    ]);

    const failure = rpcError(body);
    if (failure !== null) {
      warn(`getTransaction failed for ${entry.signature}, skipping: ${failure}`);
      continue;
    }

    const result = extractRawMember(body, 'result');
    if (result === null || result === 'null') {
      warn(`getTransaction returned no result for ${entry.signature}, skipping`);
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

// --- CLI entry point --------------------------------------------------------

const CLUSTERS = ['mainnet-beta', 'devnet', 'testnet', 'localnet'] as const;
const OUTCOMES = ['failed', 'succeeded', 'any'] as const;

const USAGE = `Usage: recordFixture.ts [options]

  --program <base58>     Program address to enumerate (required)
  --case <name>          Case directory name, e.g. 02-anchor-user-error (required)
  --covers <text>        What the case proves (required)
  --recorded-on <date>   ISO date, e.g. 2025-01-15 (required)
  --outcome <filter>     failed | succeeded | any (required, never defaulted)
  --out-dir <path>       Destination root (default: tests/golden)
  --cluster <name>       ${CLUSTERS.join(' | ')} (default: mainnet-beta)
  --rpc-url <url>        RPC endpoint (default: https://api.mainnet-beta.solana.com)
  --limit <n>            Candidate signatures to examine (default: 100)
`;

/**
 * Minimal `--flag value` parse. Hand-rolled rather than commander because this
 * file never ships and the flag set is fixed.
 */
export function parseArgs(args: readonly string[]): RecordOptions {
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

  const outcome = required('outcome');
  if (!(OUTCOMES as readonly string[]).includes(outcome)) {
    throw new RecorderError(`--outcome must be one of ${OUTCOMES.join(', ')}`);
  }

  const rawLimit = flags.get('limit') ?? '100';
  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RecorderError(`--limit must be a positive integer, got ${rawLimit}`);
  }

  return {
    programAddress: required('program'),
    rpcUrl: flags.get('rpc-url') ?? 'https://api.mainnet-beta.solana.com',
    limit,
    outDir: flags.get('out-dir') ?? 'tests/golden',
    caseName: required('case'),
    cluster: cluster as RecordOptions['cluster'],
    covers: required('covers'),
    recordedOn: required('recorded-on'),
    outcome: outcome as OutcomeFilter,
  };
}

async function main(args: readonly string[]): Promise<number> {
  let options: RecordOptions;
  try {
    options = parseArgs(args);
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    stderr.write(USAGE);
    return 2;
  }

  try {
    const recorded = await recordTransactions(options);
    const fixture = recorded[0];
    if (fixture === undefined) {
      warn(
        `no ${options.outcome} transaction found for ${options.programAddress} ` +
          `in the first ${options.limit} signatures`,
      );
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
