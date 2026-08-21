/**
 * Exit codes and the stream policy. Satisfies Requirement 22 (22.1–22.6), and
 * carries the two defensive render-failure paths of Requirements 12.7 and 13.6.
 *
 * Four exit classes, and one function that decides between them.
 *
 * | code | meaning                                            | Requirement |
 * | ---- | -------------------------------------------------- | ----------- |
 * | `0`  | analysis completed, transaction succeeded on chain | 22.1        |
 * | `1`  | analysis completed, transaction failed on chain    | 22.2        |
 * | `2`  | usage or input error                               | 22.3        |
 * | `3`  | fetch or fixture error                             | 22.4        |
 *
 * **Exit 1 is a signal, not an error.** The tool worked; the transaction it
 * analyzed did not. The analysis is still rendered to stdout in that case, which
 * is the whole point of the tool — a developer runs Opsis *because* a transaction
 * failed. Folding that case into 2 or 3 would make the shell idiom
 * `opsis SIG || handle_tool_failure` wrong for the single most common invocation.
 * That is why `ProgramOutcome`'s completed-analysis variant carries the whole
 * `Analysis`: the object this module reads `succeeded` from is literally the
 * object the renderer writes to stdout, so "exit 1 and an analysis on stdout"
 * cannot come apart, and the variant cannot be claimed without one in hand.
 *
 * ## Three deliberate decisions, recorded because a reader will ask
 *
 * **1. `ExitCode` is branded, not a bare numeric union and not an `enum`.**
 * design.md declares `const enum ExitCode`. A `const enum` is the wrong tool
 * under `verbatimModuleSyntax`, and — measured, not assumed — TypeScript 5.9
 * still accepts a bare numeric literal where a numeric `enum` type is expected,
 * so an `enum` would not stop `return 1` in a fetch-error branch. Only a brand
 * does. The four constants below are the only inhabitants of the type, produced
 * by the single cast in `code()`, so every exit code in the codebase is one of
 * four named things. The values are still ordinary numbers at runtime, which is
 * what `process.exit` in `bin/opsis.js` needs.
 *
 * **2. `writeDiagnostic` takes the stream.** design.md gives it the signature
 * `writeDiagnostic(message)` and also declares `cli.ts` the owner of the only
 * `process.stderr` reference in the codebase. Both cannot hold if this module
 * reaches for `process.stderr` itself. The parameter resolves it in the
 * direction the rest of the codebase already leans: `config.ts` takes `env`
 * rather than reading `process.env`, `idlStore.ts` returns `IdlWarning[]` rather
 * than emitting them, and neither needs a captured global to be tested. So
 * `cli.ts` keeps the only `process.stderr` reference and passes it in; this
 * module holds no global stream and is testable against a collector. It remains
 * the only sanctioned path for diagnostics, warnings, errors, IDL load warnings,
 * the Req 16.7 endpoint line, and error-path usage text — all to stderr
 * (Req 22.5). Nothing here can write to stdout: no code path touches a second
 * stream, and callers pass stderr.
 *
 * **3. A render failure exits 2, and this is the one code the requirements do
 * not dictate.** Requirements 12.7 and 13.6 mandate a stderr message for an
 * empty-or-malformed `Analysis` and for a value JSON cannot represent, but name
 * no exit code, and Requirement 22 enumerates no render failure at all. Both
 * paths are unreachable from a well-typed `Analysis` — the model admits no
 * `Date`, no `Map`, no `bigint`, no cycle — and exist as defensive guards. 2 is
 * the nearest defined class: the run produced no analysis on stdout, so 0 and 1
 * are both false, and nothing was fetched or read, so 3 would misreport where
 * the failure was. Recorded here rather than left implicit at the call site.
 *
 * Nothing in this module calls `process.exit`, reads a clock, or reads a process
 * id. `main` returns an `ExitCode` and the `bin/opsis.js` shim is the only place
 * the process is terminated (design.md, `cli.ts`). A timestamp in a diagnostic
 * would break the determinism `Analysis` is built to guarantee (Req 9.5), so
 * there is no clock here to reach for.
 */

import type { ConfigError } from './config.js';
import type { Analysis } from './model/analysis.js';
import type { SignatureError } from './signature.js';
import type { SourceError } from './source/index.js';

// ---------------------------------------------------------------------------
// ExitCode
// ---------------------------------------------------------------------------

declare const exitCodeBrand: unique symbol;

/**
 * A process exit code Opsis is allowed to terminate with.
 *
 * Branded so that only the four constants on `ExitCode` inhabit it. A bare `1`
 * does not typecheck where one of these is expected, which is the point: the
 * four classes are semantically distinct, and the type is what stops a later
 * contributor returning `1` — "it failed" — from a fetch-error branch.
 */
export type ExitCode = number & { readonly [exitCodeBrand]: never };

/** The single place a number becomes an `ExitCode`. */
function code(value: 0 | 1 | 2 | 3): ExitCode {
  return value as ExitCode;
}

/**
 * The four exit classes, by name.
 *
 * An object rather than an `enum` so the branded type above is possible; the
 * member names are design.md's.
 */
export const ExitCode = {
  /** Analysis completed and the transaction succeeded on chain (Req 22.1). */
  Success: code(0),
  /** Analysis completed and the transaction failed on chain (Req 22.2). */
  TransactionFailed: code(1),
  /** Usage or input error (Req 22.3). */
  UsageError: code(2),
  /** Fetch or fixture error (Req 22.4). */
  FetchError: code(3),
} as const;

// ---------------------------------------------------------------------------
// ProgramOutcome
// ---------------------------------------------------------------------------

/**
 * An argv-shaped usage error, detected by `cli.ts` before any of the typed
 * stages run. Requirements 1.5, 17.6, 22.3.
 *
 * The two named variants are the two rows of design.md's error table attributed
 * to `cli.ts`. `argv-invalid` covers the rest of what the argument parser can
 * reject — a flag given no value, a value of the wrong shape — so that the usage
 * class is total without this module having to enumerate `commander`'s error
 * catalogue.
 */
export type ArgvError =
  | { readonly kind: 'missing-signature' }
  | { readonly kind: 'unrecognized-flag'; readonly flag: string }
  | { readonly kind: 'argv-invalid'; readonly detail: string };

/**
 * Every input error that exits 2, from the three modules that detect one.
 *
 * The three sets of `kind` values are disjoint, so the union stays a
 * discriminated union and `cli.ts` can format a message by switching on `kind`
 * alone.
 */
export type UsageError = ArgvError | SignatureError | ConfigError;

/** Which renderer failed. Requirements 12.7, 13.6. */
export type Renderer = 'text' | 'json';

/**
 * Every way a run of Opsis can end.
 *
 * One discriminated union rather than four call sites each picking a number:
 * classification happens once, where the failure is detected, and the mapping to
 * a code happens once, in `exitCodeFor`. `cli.ts` therefore never chooses an
 * exit code — it constructs an outcome and asks.
 */
export type ProgramOutcome =
  /**
   * The pipeline ran and produced an `Analysis`. Code 0 or 1 depending on
   * `analysis.outcome.succeeded` (Req 22.1, 22.2). Carries the `Analysis` and
   * not just its `TransactionOutcome` so that the value the code is derived from
   * is the value stdout receives.
   */
  | { readonly kind: 'analyzed'; readonly analysis: Analysis }
  /**
   * `--help` or `--version` was requested and served. A completed operation, so
   * code 0 (Req 22.1); its output is the one thing besides a rendered analysis
   * that belongs on stdout (Req 22.6).
   */
  | { readonly kind: 'info-requested'; readonly request: 'help' | 'version' }
  /** A usage or input error. Code 2 (Req 22.3). */
  | { readonly kind: 'usage'; readonly error: UsageError }
  /** A fetch or fixture error. Code 3 (Req 22.4). */
  | { readonly kind: 'source'; readonly error: SourceError }
  /**
   * A renderer refused to produce output. Code 2; see decision 3 in the module
   * header — this is the one assignment the requirements do not dictate.
   */
  | {
      readonly kind: 'render-failure';
      readonly renderer: Renderer;
      readonly detail: string;
    };

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

/**
 * Every `SourceError` kind, mapped explicitly to its exit code.
 *
 * A total record rather than a `switch` returning one constant, for two reasons.
 * A new `SourceError` variant makes this object a compile error until it is
 * given a code, so the mapping cannot silently default. And `fixture-unreadable`
 * is written out here where a reader can see it is **3 and not 2**: a corrupt
 * fixture reads like a usage error — the user did point Opsis at a bad file —
 * but Requirement 22.4 names "a fixture file that fails to load" among the fetch
 * and fixture errors, and design.md's error table puts it at 3. The distinction
 * matters to a script: 2 means "you invoked me wrongly", 3 means "I could not
 * obtain the transaction", and a broken fixture is the second.
 */
export const SOURCE_ERROR_EXIT_CODES: {
  readonly [K in SourceError['kind']]: ExitCode;
} = {
  /** Requirement 2.3, 22.4. */
  'not-found': ExitCode.FetchError,
  /** Requirement 2.4, 22.4. */
  network: ExitCode.FetchError,
  /** Requirement 2.1, 2.5, 22.4. */
  timeout: ExitCode.FetchError,
  /** Requirement 16.6, 22.4. */
  unreachable: ExitCode.FetchError,
  /** Requirement 2.8, 10.3, 22.4. */
  'fixture-unreadable': ExitCode.FetchError,
};

/**
 * The exit code for one outcome. Total, and the only producer of an exit code
 * for a terminating path.
 *
 * Exhaustive without a `default`: adding a variant to `ProgramOutcome` and not
 * handling it here leaves a code path that returns nothing, which the declared
 * return type rejects at compile time.
 */
export function exitCodeFor(outcome: ProgramOutcome): ExitCode {
  switch (outcome.kind) {
    case 'analyzed':
      // The one branch that reads data rather than a classification. Req 22.1,
      // 22.2.
      return outcome.analysis.outcome.succeeded
        ? ExitCode.Success
        : ExitCode.TransactionFailed;

    case 'info-requested':
      return ExitCode.Success;

    case 'usage':
      // Every `UsageError` variant is code 2 by Requirement 22.3, which
      // enumerates them: invalid signature, missing signature, unrecognized
      // flag, invalid RPC URL. No per-kind table, because there is nothing to
      // vary.
      return ExitCode.UsageError;

    case 'source':
      return SOURCE_ERROR_EXIT_CODES[outcome.error.kind];

    case 'render-failure':
      // Decision 3 in the module header. Not dictated by the requirements.
      return ExitCode.UsageError;
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * The stream `writeDiagnostic` writes to.
 *
 * Narrowed to the one method used so a test can pass a collector, and so this
 * module depends on nothing about `process`. `process.stderr` satisfies it.
 */
export interface DiagnosticStream {
  write(chunk: string): unknown;
}

/**
 * Write one diagnostic line to `stream`, which is always stderr in the shipped
 * CLI. Requirement 22.5.
 *
 * The only sanctioned path for diagnostics, warnings, error messages, IDL load
 * warnings, the chosen-endpoint line, and error-path usage text. Routing all of
 * them through one function is what makes Requirement 22.6 checkable by reading
 * call sites: stdout is written by the renderers and by `--help`/`--version`,
 * and by nothing else.
 *
 * Exactly one trailing newline is emitted, whether or not `message` already
 * ended with one, so a caller cannot produce a blank line by accident and two
 * callers cannot disagree about whose job the newline is. Interior newlines are
 * preserved verbatim, because multi-line usage text is one diagnostic and not
 * several. An empty message writes nothing at all: a bare newline on stderr is
 * noise, never a diagnostic.
 */
export function writeDiagnostic(stream: DiagnosticStream, message: string): void {
  const body = message.replace(/[\r\n]+$/, '');
  if (body === '') return;
  stream.write(`${body}\n`);
}
