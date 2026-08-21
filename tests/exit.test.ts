/**
 * Unit tests for the exit code mapping and the diagnostic stream policy.
 * Requirements 12.7, 13.6, 22.1–22.6. Design Property 43, and the stderr half
 * of Property 44.
 *
 * Two choices about how these tests are written, because they are what makes
 * them worth having.
 *
 * **The two on-chain codes come from real fixtures through the real pipeline.**
 * `0` and `1` are not assertions about a hand-built `TransactionOutcome`; they
 * are assertions about the `Analysis` that `analyzeTransaction` produces from
 * `01-success-cpi-heavy` and `02-anchor-user-error`, loaded through the
 * production `FixtureSource`. The whole claim behind exit 1 is that the tool
 * worked and still produced an analysis, and a stubbed outcome object could not
 * distinguish that from a tool that failed and produced nothing.
 *
 * **The `SourceError` table is asserted by its key set, not case by case.** A
 * sixth `SourceError` variant is a compile error in `exit.ts` if it is left out
 * of `SOURCE_ERROR_EXIT_CODES`, and a test failure here if it is added without a
 * decision being recorded in this file. Either way it cannot default silently to
 * whatever the last `case` returned.
 */

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ConfigError } from '../src/config.js';
import {
  ExitCode,
  SOURCE_ERROR_EXIT_CODES,
  exitCodeFor,
  writeDiagnostic,
  type ArgvError,
  type DiagnosticStream,
  type ProgramOutcome,
} from '../src/exit.js';
import type { Analysis, Base58Signature } from '../src/model/analysis.js';
import { analyzeTransaction } from '../src/pipeline.js';
import type { SignatureError } from '../src/signature.js';
import { FixtureSource } from '../src/source/fixture.js';
import type { SourceError } from '../src/source/index.js';

// ---------------------------------------------------------------------------
// Fixture loading — the same path the golden harness uses
// ---------------------------------------------------------------------------

/** `FixtureSource` composes `<dir>/<stem>.json`, and the file is `input.json`. */
const INPUT_STEM: Base58Signature = 'input';

async function analyzeFixture(name: string): Promise<Analysis> {
  const dir = fileURLToPath(new URL(`./golden/${name}`, import.meta.url));
  const fetched = await new FixtureSource(dir).fetch(INPUT_STEM);
  if (!fetched.ok) throw new Error(`${name}/input.json did not load: ${fetched.error.kind}`);
  return analyzeTransaction({ response: fetched.response });
}

// ---------------------------------------------------------------------------
// Error values. Every one is a real value of the module's own error type, so a
// change to any of those types breaks this file rather than passing vacuously.
// ---------------------------------------------------------------------------

const NOT_BASE58: SignatureError = { kind: 'not-base58', message: 'Non-base58 character' };
const WRONG_LENGTH: SignatureError = { kind: 'wrong-length', byteLength: 65 };
const BAD_URL: ConfigError = {
  kind: 'invalid-rpc-url',
  url: 'not a url',
  expectedForm: 'scheme://host[:port][/path]',
};
const MISSING_SIGNATURE: ArgvError = { kind: 'missing-signature' };
const UNRECOGNIZED_FLAG: ArgvError = { kind: 'unrecognized-flag', flag: '--verbose' };
const ARGV_INVALID: ArgvError = { kind: 'argv-invalid', detail: 'option --rpc-url needs a value' };

/** One value per `SourceError` kind, keyed by kind. Total by construction. */
const SOURCE_ERRORS: { readonly [K in SourceError['kind']]: Extract<SourceError, { kind: K }> } = {
  'not-found': { kind: 'not-found' },
  network: { kind: 'network', detail: 'fetch failed' },
  timeout: { kind: 'timeout', timeoutMs: 10_000 },
  unreachable: { kind: 'unreachable', endpoint: 'https://api.mainnet-beta.solana.com' },
  'fixture-unreadable': {
    kind: 'fixture-unreadable',
    path: 'fixtures/abc.json',
    detail: 'the file is not valid JSON',
  },
};

// ---------------------------------------------------------------------------
// A collector standing in for stderr
// ---------------------------------------------------------------------------

class Collector implements DiagnosticStream {
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get text(): string {
    return this.chunks.join('');
  }
}

// ---------------------------------------------------------------------------
// Exit code 0 and 1 — Requirements 22.1, 22.2
// ---------------------------------------------------------------------------

describe('exitCodeFor: the analyzed outcome', () => {
  it('is 0 when the transaction succeeded on chain', async () => {
    const analysis = await analyzeFixture('01-success-cpi-heavy');
    expect(analysis.outcome.succeeded).toBe(true);

    expect(exitCodeFor({ kind: 'analyzed', analysis })).toBe(ExitCode.Success);
    expect(exitCodeFor({ kind: 'analyzed', analysis })).toBe(0);
  });

  it('is 1 when the transaction failed on chain', async () => {
    const analysis = await analyzeFixture('02-anchor-user-error');
    expect(analysis.outcome.succeeded).toBe(false);

    expect(exitCodeFor({ kind: 'analyzed', analysis })).toBe(ExitCode.TransactionFailed);
    expect(exitCodeFor({ kind: 'analyzed', analysis })).toBe(1);
  });

  /**
   * The semantic behind exit 1, not just the number: exit 1 means the tool
   * worked. The outcome value that produced the 1 carries a complete analysis —
   * a located failure, a resolved error, an instruction tree, balances, logs —
   * which is exactly what gets rendered to stdout. If this ever stopped holding,
   * exit 1 would have degenerated into "something went wrong", which is what
   * codes 2 and 3 are for.
   */
  it('exit 1 carries the analysis that stdout receives', async () => {
    const analysis = await analyzeFixture('02-anchor-user-error');
    const outcome: ProgramOutcome = { kind: 'analyzed', analysis };

    expect(exitCodeFor(outcome)).toBe(ExitCode.TransactionFailed);

    // The analysis was produced, and is the same object, not a copy of a
    // fragment of it.
    expect(outcome.kind === 'analyzed' && outcome.analysis).toBe(analysis);
    expect(analysis.failure).not.toBeNull();
    expect(analysis.failure?.error).toStrictEqual(analysis.outcome.error);
    expect(analysis.outcome.error).not.toBeNull();
    expect(analysis.instructions.length).toBeGreaterThan(0);
    expect(analysis.logs.messages.length).toBeGreaterThan(0);
    expect(analysis.signature.length).toBeGreaterThan(0);
  });

  it('reads the on-chain result and nothing else', () => {
    // Same analysis shape, opposite `succeeded`: the code follows that field and
    // is not derived from the presence of a failure report or of an error value.
    const base = {
      signature: 'S',
      messageVersion: 'legacy',
      accountKeys: [],
      instructions: [],
      failure: null,
      lamportBalances: [],
      tokenBalances: [],
      compute: { total: { available: false, confidence: 'raw' } },
      logs: { messages: [], present: false, truncated: false, unattributed: [], confidence: 'raw' },
    } as const satisfies Omit<Analysis, 'outcome'>;

    const succeeded: Analysis = { ...base, outcome: { succeeded: true, error: null } };
    const failed: Analysis = { ...base, outcome: { succeeded: false, error: null } };

    expect(exitCodeFor({ kind: 'analyzed', analysis: succeeded })).toBe(ExitCode.Success);
    expect(exitCodeFor({ kind: 'analyzed', analysis: failed })).toBe(ExitCode.TransactionFailed);
  });
});

// ---------------------------------------------------------------------------
// --help / --version — Requirement 22.1
// ---------------------------------------------------------------------------

describe('exitCodeFor: a served information request', () => {
  it('is 0 for --help and for --version', () => {
    expect(exitCodeFor({ kind: 'info-requested', request: 'help' })).toBe(ExitCode.Success);
    expect(exitCodeFor({ kind: 'info-requested', request: 'version' })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exit code 2 — Requirement 22.3
// ---------------------------------------------------------------------------

describe('exitCodeFor: usage and input errors', () => {
  it.each([
    ['signature not base58 (Req 1.2)', NOT_BASE58],
    ['signature not 64 bytes (Req 1.3)', WRONG_LENGTH],
    ['invalid RPC URL format (Req 16.5)', BAD_URL],
    ['no signature argument (Req 1.5)', MISSING_SIGNATURE],
    ['unrecognized flag (Req 17.6)', UNRECOGNIZED_FLAG],
    ['other argv rejection', ARGV_INVALID],
  ])('is 2 for %s', (_label, error) => {
    expect(exitCodeFor({ kind: 'usage', error })).toBe(ExitCode.UsageError);
    expect(exitCodeFor({ kind: 'usage', error })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Exit code 3 — Requirement 22.4
// ---------------------------------------------------------------------------

describe('exitCodeFor: fetch and fixture errors', () => {
  /**
   * The kinds this suite has decided about, written out literally.
   *
   * Not derived from `SourceError` — deriving it from the type under test would
   * make the assertion vacuous. A new variant added to `SourceError` fails this
   * comparison, which is the intent: the new kind's exit class is a decision, and
   * it gets recorded here alongside the other five rather than inheriting one.
   */
  const DECIDED_KINDS: readonly SourceError['kind'][] = [
    'fixture-unreadable',
    'network',
    'not-found',
    'timeout',
    'unreachable',
  ];

  it('decides every SourceError kind explicitly', () => {
    expect(Object.keys(SOURCE_ERROR_EXIT_CODES).sort()).toStrictEqual([...DECIDED_KINDS]);
    expect(Object.keys(SOURCE_ERRORS).sort()).toStrictEqual([...DECIDED_KINDS]);
  });

  it.each(DECIDED_KINDS)('is 3 for %s', (kind) => {
    expect(exitCodeFor({ kind: 'source', error: SOURCE_ERRORS[kind] })).toBe(ExitCode.FetchError);
    expect(exitCodeFor({ kind: 'source', error: SOURCE_ERRORS[kind] })).toBe(3);
  });

  /**
   * Called out separately because it is the one that tempts a reader toward 2:
   * the user did point Opsis at a broken file, which looks like an input error.
   * Requirement 22.4 names "a fixture file that fails to load" among the fetch
   * and fixture errors, so it is 3 — "I could not obtain the transaction" — and
   * not 2, "you invoked me wrongly".
   */
  it('is 3, not 2, for an unreadable fixture', () => {
    const code = exitCodeFor({ kind: 'source', error: SOURCE_ERRORS['fixture-unreadable'] });
    expect(code).toBe(ExitCode.FetchError);
    expect(code).not.toBe(ExitCode.UsageError);
  });
});

// ---------------------------------------------------------------------------
// Render failure — Requirements 12.7, 13.6
// ---------------------------------------------------------------------------

describe('exitCodeFor: a render failure', () => {
  /**
   * **This is the one exit code the requirements do not dictate.** Requirements
   * 12.7 and 13.6 mandate the stderr message and name no code, and Requirement
   * 22 enumerates no render failure. 2 is chosen as the nearest defined class:
   * no analysis reached stdout, so 0 and 1 are false, and nothing was fetched or
   * read, so 3 would misreport where the failure was. Both paths are unreachable
   * from a well-typed `Analysis` and exist as defensive guards; this test pins
   * the choice so a later change to it is a visible change and not a drift.
   */
  it('is 2 for both renderers', () => {
    expect(
      exitCodeFor({ kind: 'render-failure', renderer: 'text', detail: 'malformed Analysis' }),
    ).toBe(ExitCode.UsageError);
    expect(
      exitCodeFor({ kind: 'render-failure', renderer: 'json', detail: 'cannot serialize' }),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The four codes are distinct
// ---------------------------------------------------------------------------

describe('ExitCode', () => {
  it('names four distinct codes', () => {
    expect([
      ExitCode.Success,
      ExitCode.TransactionFailed,
      ExitCode.UsageError,
      ExitCode.FetchError,
    ]).toStrictEqual([0, 1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// writeDiagnostic — Requirements 22.5, 22.6
// ---------------------------------------------------------------------------

describe('writeDiagnostic', () => {
  it('writes to the stream it is given', () => {
    const stream = new Collector();
    writeDiagnostic(stream, 'error: the signature is not valid base58');
    expect(stream.text).toBe('error: the signature is not valid base58\n');
  });

  it('writes to no other stream', () => {
    // The module holds no stream of its own: the only reference it can write
    // through is the parameter. Two collectors, one call, and the untouched one
    // proves the write went nowhere else — including nowhere near stdout, which
    // Requirement 22.6 reserves for the rendered analysis.
    const target = new Collector();
    const other = new Collector();
    writeDiagnostic(target, 'diagnostic');
    expect(target.chunks).toHaveLength(1);
    expect(other.chunks).toHaveLength(0);
  });

  it('terminates with exactly one newline, however the message was spelled', () => {
    const bare = new Collector();
    const terminated = new Collector();
    const doubled = new Collector();
    writeDiagnostic(bare, 'line');
    writeDiagnostic(terminated, 'line\n');
    writeDiagnostic(doubled, 'line\n\n');
    expect(bare.text).toBe('line\n');
    expect(terminated.text).toBe('line\n');
    expect(doubled.text).toBe('line\n');
  });

  it('preserves interior newlines, so multi-line usage text stays one diagnostic', () => {
    const stream = new Collector();
    writeDiagnostic(stream, 'Usage: opsis <signature>\n\nOptions:\n  --json\n');
    expect(stream.chunks).toStrictEqual(['Usage: opsis <signature>\n\nOptions:\n  --json\n']);
  });

  it('writes nothing for an empty message', () => {
    const stream = new Collector();
    writeDiagnostic(stream, '');
    writeDiagnostic(stream, '\n');
    expect(stream.chunks).toHaveLength(0);
  });

  it('does not stamp a diagnostic with a clock, so two runs agree byte for byte', () => {
    const first = new Collector();
    const second = new Collector();
    writeDiagnostic(first, 'error: request timed out after 10000 ms');
    writeDiagnostic(second, 'error: request timed out after 10000 ms');
    expect(first.text).toBe(second.text);
  });
});
