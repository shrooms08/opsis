/**
 * The command line. Satisfies Requirements 1.4, 1.5, 16.7, 17.1–17.7, 22.5, 22.6.
 *
 * This module is the composition root, and it is the only module in `src/` that
 * touches `process`. Everything below it takes what it needs as an argument and
 * returns what it produced as a value: `config.ts` takes `env`, `exit.ts` takes
 * the stream to write to, `idlStore.ts` returns its warnings, the source layer
 * returns typed errors, and the renderers return typed failures. `main` is where
 * those values become an exit code, a line on stderr, and text on stdout.
 *
 * ```
 * argv → parseArgv → signature → config → source → pipeline → renderer → ExitCode
 * ```
 *
 * ## Five decisions, recorded because a reader will ask
 *
 * **1. `main` takes its environment as a parameter, defaulted to the real one.**
 * design.md declares the signature `main(argv)` and also declares this module the
 * owner of the only `process.stdout`, `process.stderr`, `process.argv`, and
 * `process.env` references in the codebase. A defaulted second parameter honours
 * both: `main(argv)` is the design.md spelling and works standalone, while a test
 * passes collector streams and a fixed environment and drives the whole program
 * without capturing a global or terminating the runner. The direction is the one
 * the rest of the codebase already leans — `resolveConfig(options, env)`,
 * `writeDiagnostic(stream, message)`, `decideColorMode({ env, isTty })` — so the
 * context object is assembled here, once, by {@link processContext}.
 *
 * **2. There is no fixture flag, because the requirements sanction none.**
 * Requirement 10.1 states the whole rule: when `./fixtures/<signature>.json`
 * exists it is loaded and no network request is issued; when it does not
 * (Req 10.4) the RPC endpoint is asked. The lookup root is therefore not a user
 * choice — it is `ResolvedConfig.fixtureDir`, fixed at `./fixtures` by
 * `config.ts`, and offline operation is reached by *having the file*, not by
 * passing a flag. So the flag list here is exactly design.md's, `CompositeSource`
 * is wired unconditionally, and every run consults fixtures first. `fixtureDir`
 * is relative, so it is resolved against `context.cwd` rather than left to the
 * implicit process working directory: same behaviour in production, and a test
 * can point a run at a temp directory without `process.chdir`. `idlDir` is
 * resolved the same way for the same reason.
 *
 * **3. `commander` never sees a real stream.** Its output is collected into
 * strings by {@link parseArgv}, which stays pure, and `main` writes those strings
 * — help and version to stdout (Req 17.1, 17.2, 22.6), error text and error-path
 * usage to stderr through `writeDiagnostic` (Req 17.6, 22.5). commander's default
 * is to mix both onto stdout, which would put an error message into
 * `opsis SIG --json | jq`. Routing through `configureOutput` and then through
 * `writeDiagnostic` keeps Requirement 22.6 checkable by reading call sites:
 * `stdout.write` appears twice in this file, once for `--help`/`--version` text
 * and once for a rendered analysis, and nowhere else.
 *
 * **4. `--version` outranks `--help` by removing the help tokens, not by
 * short-circuiting.** Requirement 17.7 asks for the version and *only* the
 * version when both flags are given. commander serves whichever it encounters
 * first, so {@link prioritizeVersion} drops the help tokens when a version token
 * is also present and lets commander parse what remains. Dropping rather than
 * returning early keeps one producer of the version text — commander's own
 * `--version` option — instead of a second spelling of it here.
 *
 * A consequence worth stating, because the requirements do not settle it: an
 * information request also outranks an unrecognized flag. commander serves
 * `--version` and `--help` as it encounters them and reports unknown options only
 * once option parsing has finished, so `opsis --bogus --version` prints the
 * version and `opsis --bogus --help` prints help, both exiting 0 rather than
 * naming `--bogus` (Req 17.6). Requirements 17.1/17.2 and Requirement 17.6 both
 * apply to those argvs and neither is qualified. commander's ordering is kept
 * because it is what every mainstream CLI does — `git --bogus --version` prints a
 * version — and because these are the two flags whose purpose is to answer when
 * the rest of the invocation is in doubt. `opsis --bogus` on its own still exits 2
 * and names the flag.
 *
 * **5. Exit codes are asked for, never chosen.** Every terminating path builds a
 * `ProgramOutcome` and calls `exitCodeFor`. There is no numeric literal in this
 * file, which is what makes `exit.ts`'s table the single account of what Opsis
 * exits with (Req 22.1–22.4).
 *
 * `process.exit` is not called here. `main` returns an `ExitCode` and
 * `bin/opsis.js` terminates the process with it.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { Command, CommanderError } from 'commander';

import { DEFAULT_RPC_URL, resolveConfig, type CliOptions } from './config.js';
import {
  loadIdlDirectory,
  type IdlStore,
  type IdlWarning,
} from './decode/idl/idlStore.js';
import {
  exitCodeFor,
  writeDiagnostic,
  type ArgvError,
  type ExitCode,
  type UsageError,
} from './exit.js';
import type { Base58Signature } from './model/analysis.js';
import { analyzeTransaction } from './pipeline.js';
import { renderJson } from './render/json.js';
import { decideColorMode, renderText } from './render/text.js';
import { validateSignature } from './signature.js';
import { CompositeSource } from './source/composite.js';
import { FixtureSource } from './source/fixture.js';
import type { SourceError } from './source/index.js';
import { RpcSource } from './source/rpc.js';

export type { CliOptions } from './config.js';

/** The command name, used in every diagnostic and in the usage text. */
export const PROGRAM_NAME = 'opsis';

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * `package.json`, resolved relative to this module rather than to the working
 * directory.
 *
 * From `dist/cli.js` this is `<package>/package.json`, and from `src/cli.ts`
 * under vitest it is the same file, so the version reported by `--version` is the
 * one npm published (Req 17.5). Read at runtime rather than imported, because
 * `rootDir` is `src/` and an import of `../package.json` would either land
 * outside the build root or bake a copy of the manifest into `dist/`.
 */
const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);

/** Reported when the manifest cannot be read. See {@link readVersion}. */
const UNKNOWN_VERSION = '0.0.0-unknown';

let cachedVersion: string | null = null;

/**
 * The `version` field of `package.json` (Req 17.5).
 *
 * Cached, so repeated `parseArgv` calls in a test read the file once. A failure
 * degrades to {@link UNKNOWN_VERSION} rather than throwing: `--version` is the
 * flag a user reaches for when something is already wrong, and a crash there
 * would be a worse answer than an honest placeholder. The file is part of every
 * npm tarball and of the repository, so the fallback is not a path anyone should
 * see.
 */
function readVersion(): string {
  if (cachedVersion !== null) return cachedVersion;

  let version = UNKNOWN_VERSION;
  try {
    const parsed: unknown = JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const declared = (parsed as { readonly version?: unknown }).version;
      if (typeof declared === 'string' && declared !== '') version = declared;
    }
  } catch {
    // Fall through to the placeholder.
  }

  cachedVersion = version;
  return version;
}

// ---------------------------------------------------------------------------
// The parsed argv surface
// ---------------------------------------------------------------------------

/**
 * What argv turned out to be: a run to perform, information to print, or a
 * usage error to report.
 *
 * `text` and `message` are carried as strings rather than written here, so
 * `parseArgv` performs no I/O and a test can assert on the exact bytes each
 * stream would receive. `message` is the whole stderr payload for the error —
 * commander's error line followed by the usage text (Req 17.6) — and is ready to
 * hand to `writeDiagnostic` unchanged.
 */
export type ParseResult =
  | { readonly kind: 'options'; readonly options: CliOptions }
  | { readonly kind: 'info'; readonly request: 'help' | 'version'; readonly text: string }
  | { readonly kind: 'error'; readonly error: ArgvError; readonly message: string };

/** What commander wrote, per stream, during one parse. */
interface Collected {
  readonly out: string[];
  readonly err: string[];
}

/**
 * The usage example Requirement 17.4 asks for, plus the two things a first-time
 * reader needs: that fixtures are consulted before the network (Req 10.1) and
 * what the exit codes mean (Req 22.1–22.4).
 */
const HELP_EXAMPLES = `
Examples:
  $ ${PROGRAM_NAME} 5htUvgnugDJHSwsoZUxiAJifCXjBUtNMJnjU5MPD8KokhwVNrpZkoSqk4E1kTL4WfjGsSYwndyNwfSedKG8ipkTA
  $ ${PROGRAM_NAME} <signature> --json | jq .failure
  $ ${PROGRAM_NAME} <signature> --idl-dir ./idls --rpc-url http://127.0.0.1:8899

Fixtures:
  When ./fixtures/<signature>.json exists it is used and no network request is
  made, so a recorded transaction can be analyzed with no connectivity.

Exit codes:
  0  analysis completed, the transaction succeeded on chain
  1  analysis completed, the transaction failed on chain
  2  usage or input error
  3  fetch or fixture error`;

/**
 * A fresh `commander` program whose output lands in `collected` instead of on a
 * stream.
 *
 * Built per parse rather than kept at module scope: commander accumulates option
 * values on the instance, so a shared program would let one parse observe the
 * previous one's flags.
 */
function buildProgram(collected: Collected): Command {
  const program = new Command();

  program
    .name(PROGRAM_NAME)
    .usage('<signature> [options]')
    .description(
      'Explain what a Solana transaction did, with emphasis on why it failed.\n' +
        'Read-only: never signs, sends, or simulates.',
    )
    .argument('<signature>', 'transaction signature to analyze, base58, 64 bytes decoded')
    .option('--json', 'write the analysis to stdout as canonical JSON instead of text')
    .option(
      '--rpc-url <url>',
      `RPC endpoint to query (default: $OPSIS_RPC_URL, else ${DEFAULT_RPC_URL})`,
    )
    .option('--idl-dir <dir>', 'directory of Anchor IDL JSON files to load for decoding')
    .version(readVersion(), '-V, --version', 'output the version number')
    .helpOption('-h, --help', 'display this help text')
    .allowExcessArguments(false)
    // Requirement 17.6: the offending flag, then usage instructions — and both
    // on stderr, which `configureOutput` below guarantees.
    .showHelpAfterError()
    .addHelpText('after', HELP_EXAMPLES)
    // Turns commander's `process.exit` into a thrown `CommanderError`, so this
    // module keeps the only decision about how the program terminates.
    .exitOverride()
    .configureOutput({
      writeOut: (str) => {
        collected.out.push(str);
      },
      writeErr: (str) => {
        collected.err.push(str);
      },
      // Every commander error line is prefixed like every diagnostic this module
      // writes, so a user sees one voice rather than two.
      outputError: (str, write) => {
        write(`${PROGRAM_NAME}: ${str}`);
      },
    });

  return program;
}

/** The long flags that consume the token after them. See {@link prioritizeVersion}. */
const VALUE_TAKING_FLAGS: readonly string[] = ['--rpc-url', '--idl-dir'];

const HELP_TOKENS: readonly string[] = ['--help', '-h'];
const VERSION_TOKENS: readonly string[] = ['--version', '-V'];

/**
 * argv with the help tokens removed when a version token is also present
 * (Req 17.7). Returned unchanged otherwise.
 *
 * The scan stops at `--` and skips the token after a value-taking flag, so a
 * value that happens to spell `-h` is not mistaken for a request for help. The
 * `--flag=value` spelling needs no such care, being a single token.
 */
function prioritizeVersion(argv: readonly string[]): readonly string[] {
  const helpAt: number[] = [];
  let versionRequested = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || token === '--') break;
    if (VALUE_TAKING_FLAGS.includes(token)) {
      index += 1;
      continue;
    }
    if (HELP_TOKENS.includes(token)) helpAt.push(index);
    else if (VERSION_TOKENS.includes(token)) versionRequested = true;
  }

  if (!versionRequested || helpAt.length === 0) return argv;
  return argv.filter((_token, index) => !helpAt.includes(index));
}

/** The flag named in commander's unknown-option message. */
function flagFrom(message: string): string {
  return /'(?<flag>[^']+)'/u.exec(message)?.groups?.['flag'] ?? message;
}

/** A string option value, or `undefined` when the flag was absent. */
function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse argv into a run, an information request, or a usage error.
 *
 * Pure: no stream is written, no global is read beyond `package.json` for the
 * version string, and nothing exits. Every commander byte is captured in
 * `collected` and handed back on the result for `main` to place.
 */
export function parseArgv(argv: readonly string[]): ParseResult {
  const collected: Collected = { out: [], err: [] };
  const program = buildProgram(collected);

  try {
    // `from: 'user'` means argv holds no `node` and no script path.
    program.parse([...prioritizeVersion(argv)], { from: 'user' });
  } catch (cause) {
    return classifyParseFailure(cause, program, collected);
  }

  const options = program.opts();
  const signature = program.processedArgs[0];

  /* c8 ignore start -- unreachable: `<signature>` is a required argument, so
     commander has already raised `commander.missingArgument` by here. Kept so the
     function is total rather than asserting. */
  if (typeof signature !== 'string') {
    return {
      kind: 'error',
      error: { kind: 'missing-signature' },
      message: `${errorLine(describeUsageError({ kind: 'missing-signature' }))}\n\n${program.helpInformation()}`,
    };
  }
  /* c8 ignore stop */

  return {
    kind: 'options',
    options: {
      signature,
      json: options['json'] === true,
      rpcUrl: stringOption(options['rpcUrl']),
      idlDir: stringOption(options['idlDir']),
    },
  };
}

/**
 * Turn whatever `program.parse` threw into a `ParseResult`.
 *
 * The four named commander codes are the four outcomes the requirements
 * distinguish: a served `--version` (17.1), a served `--help` (17.2), an
 * unrecognized flag (17.6), and a missing signature (1.5). Everything else
 * commander can reject — a flag given no value, one positional argument too many
 * — is `argv-invalid`, which is why that variant exists on `ArgvError`: the usage
 * class stays total without this module enumerating commander's catalogue.
 */
function classifyParseFailure(
  cause: unknown,
  program: Command,
  collected: Collected,
): ParseResult {
  const stderrText = collected.err.join('');

  /* c8 ignore start -- commander throws nothing but `CommanderError` from
     `parse`; this keeps an unexpected throw a usage error rather than a crash. */
  if (!(cause instanceof CommanderError)) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      kind: 'error',
      error: { kind: 'argv-invalid', detail },
      message: `${errorLine(detail)}\n\n${program.helpInformation()}`,
    };
  }
  /* c8 ignore stop */

  switch (cause.code) {
    case 'commander.version':
      return { kind: 'info', request: 'version', text: collected.out.join('') };

    // Two codes for one outcome: `-h`/`--help` reports `helpDisplayed`, and an
    // explicit `.help()` call reports `help`.
    case 'commander.helpDisplayed':
    case 'commander.help':
      return { kind: 'info', request: 'help', text: collected.out.join('') };

    case 'commander.unknownOption':
      return {
        kind: 'error',
        error: { kind: 'unrecognized-flag', flag: flagFrom(cause.message) },
        message: usageMessage(stderrText, cause.message, program),
      };

    case 'commander.missingArgument':
      return {
        kind: 'error',
        error: { kind: 'missing-signature' },
        message: usageMessage(stderrText, cause.message, program),
      };

    default:
      return {
        kind: 'error',
        error: { kind: 'argv-invalid', detail: cause.message },
        message: usageMessage(stderrText, cause.message, program),
      };
  }
}

/**
 * The stderr payload for a rejected argv: what commander wrote, or a
 * reconstruction of it if commander wrote nothing.
 *
 * The fallback matters because `writeDiagnostic` writes nothing for an empty
 * message, and a usage error that exits 2 in silence is the one failure mode a
 * user cannot act on.
 */
function usageMessage(stderrText: string, detail: string, program: Command): string {
  /* c8 ignore next -- every commander error path writes; belt and braces. */
  if (stderrText !== '') return stderrText;
  /* c8 ignore next */
  return `${errorLine(detail)}\n\n${program.helpInformation()}`;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** One diagnostic line, in the one voice this program speaks with. */
function errorLine(detail: string): string {
  return `${PROGRAM_NAME}: error: ${detail}`;
}

/**
 * Every usage error as a message, in one place.
 *
 * Total over `UsageError` — the argv variants included, even though the argv path
 * normally prints commander's own text — so that a new variant anywhere in the
 * union is a compile error here rather than a silent gap in what a user is told.
 */
function describeUsageError(error: UsageError): string {
  switch (error.kind) {
    case 'missing-signature':
      return 'no transaction signature was provided';
    case 'unrecognized-flag':
      return `unknown option '${error.flag}'`;
    case 'argv-invalid':
      return error.detail;
    // Requirement 1.2.
    case 'not-base58':
      return `invalid signature format: the argument is not valid base58 (${error.message})`;
    // Requirement 1.3, with the byte count that was actually supplied.
    case 'wrong-length':
      return `invalid signature length: the argument base58-decodes to ${error.byteLength} bytes, expected 64`;
    // Requirement 16.5, naming the URL and the form it failed to match.
    case 'invalid-rpc-url':
      return `invalid RPC URL '${error.url}': expected the form ${error.expectedForm}`;
  }
}

/**
 * Every source failure as a message. Requirements 2.3, 2.4, 2.5, 10.3, 16.6.
 *
 * The signature is quoted for `not-found` because that is the one case where the
 * user's own argument is the whole answer.
 */
function describeSourceError(error: SourceError, signature: Base58Signature): string {
  switch (error.kind) {
    case 'not-found':
      return `no transaction found for signature ${signature}`;
    case 'network':
      return `network failure: ${error.detail}`;
    case 'timeout':
      return `the RPC request did not complete within the ${error.timeoutMs} ms (${error.timeoutMs / 1000} second) limit`;
    case 'unreachable':
      return `the RPC endpoint at ${error.endpoint} cannot be reached`;
    case 'fixture-unreadable':
      return `the fixture at ${error.path} could not be loaded: ${error.detail}`;
  }
}

/** One IDL load warning. Requirements 18.4, 22.5. */
function formatIdlWarning(warning: IdlWarning): string {
  return `${PROGRAM_NAME}: warning: ${warning.path}: ${warning.reason}`;
}

// ---------------------------------------------------------------------------
// The process context
// ---------------------------------------------------------------------------

/** The one method `main` needs of a stream. `process.stdout` satisfies it. */
export interface WritableTextStream {
  write(chunk: string): unknown;
}

/**
 * Everything `main` needs from the process, passed in so a test can supply all
 * of it. See decision 1 in the module header.
 */
export interface MainContext {
  /** Rendered analysis, `--help`, `--version`. Nothing else (Req 22.6). */
  readonly stdout: WritableTextStream;
  /** Every diagnostic, warning, error, and error-path usage text (Req 22.5). */
  readonly stderr: WritableTextStream;
  /** Consulted for `OPSIS_RPC_URL`, `NO_COLOR`, `COLORTERM`, and `TERM`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether stdout is a terminal, for the Requirement 12.8 color decision. */
  readonly isTty: boolean;
  /** The directory the relative `fixtureDir` and `idlDir` resolve against. */
  readonly cwd: string;
}

/**
 * The real process, as a {@link MainContext}. The only place in `src/` that reads
 * `process.stdout`, `process.stderr`, `process.env`, or the working directory.
 */
export function processContext(): MainContext {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    isTty: process.stdout.isTTY === true,
    cwd: process.cwd(),
  };
}

/**
 * The arguments the user typed, without `node` and without the script path.
 *
 * Exported so `bin/opsis.js` need not reach for `process.argv` itself, which
 * keeps every `process` reference except `process.exit` inside this module.
 */
export function processArgv(): readonly string[] {
  return process.argv.slice(2);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** Exactly one trailing newline, whatever the text arrived with. */
function withNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Load the IDL directory and report what did not load.
 *
 * A warning never ends the run (Req 18.4): the store comes back either way, and
 * decoding falls through to the built-in decoders for whatever is missing.
 */
async function loadIdls(dir: string, stderr: WritableTextStream): Promise<IdlStore> {
  const store = await loadIdlDirectory(dir);
  for (const warning of store.warnings) {
    writeDiagnostic(stderr, formatIdlWarning(warning));
  }
  return store;
}

/**
 * Run Opsis once and report how it went.
 *
 * Returns an `ExitCode` and never calls `process.exit`, so a test can drive the
 * whole program — argv in, exit code and two streams out — without terminating
 * the runner. `bin/opsis.js` is the only place the process is terminated.
 */
export async function main(
  argv: readonly string[],
  context: MainContext = processContext(),
): Promise<ExitCode> {
  const { stdout, stderr } = context;

  const parsed = parseArgv(argv);

  // Requirements 17.1, 17.2, 22.6: served on stdout, exit 0.
  if (parsed.kind === 'info') {
    stdout.write(withNewline(parsed.text));
    return exitCodeFor({ kind: 'info-requested', request: parsed.request });
  }

  // Requirements 1.5, 17.6, 22.3, 22.5.
  if (parsed.kind === 'error') {
    writeDiagnostic(stderr, parsed.message);
    return exitCodeFor({ kind: 'usage', error: parsed.error });
  }

  const options = parsed.options;

  // Requirements 1.1–1.3. Validated before any endpoint is resolved, so a
  // malformed signature never causes a request.
  const validated = validateSignature(options.signature);
  if (!validated.ok) return reportUsage(stderr, validated.error);

  // Requirements 16.1–16.5.
  const configured = resolveConfig(options, context.env);
  if (!configured.ok) return reportUsage(stderr, configured.error);
  const config = configured.config;

  // Requirement 16.7 — stderr specifically, so `opsis SIG --json | jq` stays
  // clean. Written once the endpoint is known and valid, whether or not a
  // fixture ends up answering: the line reports what was configured.
  writeDiagnostic(stderr, `${PROGRAM_NAME}: using RPC endpoint ${config.rpcUrl}`);

  // Requirement 18.1.
  const idls =
    config.idlDir === undefined
      ? null
      : await loadIdls(resolvePath(context.cwd, config.idlDir), stderr);

  // Requirements 10.1, 10.4: fixtures first, the network only when none was
  // recorded. See decision 2 in the module header for why there is no flag.
  const source = new CompositeSource(
    new FixtureSource(resolvePath(context.cwd, config.fixtureDir)),
    new RpcSource({ endpoint: config.rpcUrl, timeoutMs: config.requestTimeoutMs }),
  );

  const fetched = await source.fetch(validated.signature);
  if (!fetched.ok) {
    // Requirements 2.3–2.5, 10.3, 16.6, 22.4.
    writeDiagnostic(stderr, errorLine(describeSourceError(fetched.error, validated.signature)));
    return exitCodeFor({ kind: 'source', error: fetched.error });
  }

  const analysis = analyzeTransaction({
    response: fetched.response,
    signature: validated.signature,
    idls,
  });

  const rendered = options.json
    ? renderJson(analysis)
    : renderText(analysis, decideColorMode({ env: context.env, isTty: context.isTty }));

  if (!rendered.ok) {
    // Requirements 12.7, 13.6. Unreachable from a well-typed `Analysis`; the
    // exit code is `exit.ts`'s decision, not one taken here.
    writeDiagnostic(stderr, errorLine(rendered.failure.message));
    return exitCodeFor({
      kind: 'render-failure',
      renderer: options.json ? 'json' : 'text',
      detail: rendered.failure.message,
    });
  }

  // The one place a rendered analysis reaches stdout (Req 22.6). Exit 0 or 1
  // follows from the very object just written (Req 22.1, 22.2).
  stdout.write(withNewline(rendered.text));
  return exitCodeFor({ kind: 'analyzed', analysis });
}

/** A usage error, reported and coded. Requirement 22.3. */
function reportUsage(stderr: WritableTextStream, error: UsageError): ExitCode {
  writeDiagnostic(stderr, errorLine(describeUsageError(error)));
  return exitCodeFor({ kind: 'usage', error });
}
