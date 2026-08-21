/**
 * The CLI, end to end. Requirements 1.2–1.5, 10.1, 16.5, 16.7, 17.1–17.7,
 * 18.4, 22.1–22.6. Design Property 44's stream discipline, at the one place a
 * stream is actually chosen.
 *
 * Three choices about how these tests are written.
 *
 * **`main` is driven directly, with collector streams.** No child process, no
 * captured global. `main(argv, context)` takes its two streams, its environment,
 * its TTY answer, and its working directory as data, so a test states the whole
 * input and reads the exact bytes each stream received — and returns an exit code
 * instead of terminating the runner.
 *
 * **The exit-0 and exit-1 cases run against real recorded fixtures.** A temp
 * directory gets a `fixtures/` subdirectory holding `<signature>.json` copied
 * verbatim from `tests/golden/`, and `context.cwd` points at it. That is exactly
 * the path Requirement 10.1 describes, so these tests exercise the offline route
 * a reviewer takes rather than a substituted source. Nothing in `src/` is mocked.
 *
 * **Nothing here reaches the network.** The task 1.3 interceptor is active and
 * would fail the suite loudly if it did. Every case either resolves from a
 * fixture on disk or points `--rpc-url` at a stub on `127.0.0.1`.
 */

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import bs58 from 'bs58';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main, parseArgv, PROGRAM_NAME, type MainContext } from '../src/cli.js';
import { DEFAULT_RPC_URL } from '../src/config.js';
import { ExitCode } from '../src/exit.js';
import { startStubRpc, type StubRpcServer } from './source/support/stubRpc.js';

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

const GOLDEN_ROOT = fileURLToPath(new URL('./golden/', import.meta.url));
const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    readonly version: string;
  }
).version;

/** A recorded case: the golden directory it came from and the signature it holds. */
interface Recorded {
  readonly directory: string;
  readonly signature: string;
}

/** A successful transaction (Req 22.1) and a failed one (Req 22.2). */
const SUCCEEDED: Recorded = {
  directory: '01-success-cpi-heavy',
  signature: signatureOf('01-success-cpi-heavy'),
};
const FAILED: Recorded = {
  directory: '02-anchor-user-error',
  signature: signatureOf('02-anchor-user-error'),
};

function signatureOf(directory: string): string {
  const meta: unknown = JSON.parse(readFileSync(join(GOLDEN_ROOT, directory, 'meta.json'), 'utf8'));
  return (meta as { readonly signature: string }).signature;
}

/** A stream that keeps what was written to it. */
interface Collector {
  write(chunk: string): boolean;
  text(): string;
}

function collector(): Collector {
  const chunks: string[] = [];
  return {
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(''),
  };
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunOptions {
  /** Defaults to the temp directory holding `fixtures/`. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTty?: boolean;
}

/** The working directory every run resolves `./fixtures` against. */
let workspace = '';

async function run(argv: readonly string[], options: RunOptions = {}): Promise<Run> {
  const out = collector();
  const err = collector();
  const context: MainContext = {
    stdout: out,
    stderr: err,
    env: options.env ?? {},
    isTty: options.isTty ?? false,
    cwd: options.cwd ?? workspace,
  };
  const code = await main(argv, context);
  return { code, stdout: out.text(), stderr: err.text() };
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'opsis-cli-'));
  const fixtures = join(workspace, 'fixtures');
  await mkdir(fixtures);
  for (const recorded of [SUCCEEDED, FAILED]) {
    await cp(
      join(GOLDEN_ROOT, recorded.directory, 'input.json'),
      join(fixtures, `${recorded.signature}.json`),
    );
  }
});

afterAll(async () => {
  if (workspace !== '') await rm(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseArgv — Requirements 1.4, 17.6
// ---------------------------------------------------------------------------

describe('parseArgv', () => {
  it('takes the signature as the first positional argument', () => {
    const parsed = parseArgv([SUCCEEDED.signature]);

    expect(parsed).toStrictEqual({
      kind: 'options',
      options: {
        signature: SUCCEEDED.signature,
        json: false,
        rpcUrl: undefined,
        idlDir: undefined,
      },
    });
  });

  it('accepts every flag, in either order relative to the signature', () => {
    const parsed = parseArgv([
      '--json',
      '--rpc-url',
      'http://127.0.0.1:8899',
      SUCCEEDED.signature,
      '--idl-dir',
      './idls',
    ]);

    expect(parsed).toStrictEqual({
      kind: 'options',
      options: {
        signature: SUCCEEDED.signature,
        json: true,
        rpcUrl: 'http://127.0.0.1:8899',
        idlDir: './idls',
      },
    });
  });

  it('accepts the --flag=value spelling', () => {
    const parsed = parseArgv([SUCCEEDED.signature, '--rpc-url=http://127.0.0.1:9999']);

    expect(parsed).toStrictEqual({
      kind: 'options',
      options: {
        signature: SUCCEEDED.signature,
        json: false,
        rpcUrl: 'http://127.0.0.1:9999',
        idlDir: undefined,
      },
    });
  });

  it('names the offending flag on an unrecognized option', () => {
    const parsed = parseArgv([SUCCEEDED.signature, '--verbose']);

    expect(parsed.kind).toBe('error');
    if (parsed.kind !== 'error') throw new Error('expected a usage error');
    expect(parsed.error).toStrictEqual({ kind: 'unrecognized-flag', flag: '--verbose' });
    expect(parsed.message).toContain("unknown option '--verbose'");
  });

  it('reports a missing signature as missing-signature', () => {
    const parsed = parseArgv([]);

    expect(parsed.kind).toBe('error');
    if (parsed.kind !== 'error') throw new Error('expected a usage error');
    expect(parsed.error).toStrictEqual({ kind: 'missing-signature' });
  });

  it('reports a flag given no value as argv-invalid', () => {
    const parsed = parseArgv([SUCCEEDED.signature, '--rpc-url']);

    expect(parsed.kind).toBe('error');
    if (parsed.kind !== 'error') throw new Error('expected a usage error');
    expect(parsed.error.kind).toBe('argv-invalid');
  });

  it('returns commander help text on the result rather than writing it anywhere', () => {
    // The purity claim, checkable: every commander byte comes back as data, so
    // there is no stream to intercept and `main` decides where it goes.
    const parsed = parseArgv(['--help']);

    expect(parsed.kind).toBe('info');
    if (parsed.kind !== 'info') throw new Error('expected an info request');
    expect(parsed.text).toContain('Usage: opsis <signature> [options]');
  });
});

// ---------------------------------------------------------------------------
// Usage errors — Requirements 1.2, 1.3, 1.5, 16.5, 17.6, 22.3, 22.5, 22.6
// ---------------------------------------------------------------------------

describe('usage errors exit 2 with a clean stdout', () => {
  it('an unrecognized flag names the flag and prints usage, on stderr only', async () => {
    const result = await run([SUCCEEDED.signature, '--verbose']);

    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown option '--verbose'");
    // Requirement 17.6: the usage instructions follow the error, on stderr.
    expect(result.stderr).toContain('Usage: opsis <signature> [options]');
  });

  it('a missing signature prints usage instructions to stderr', async () => {
    const result = await run([]);

    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: opsis <signature> [options]');
  });

  it('a signature that is not base58 exits 2', async () => {
    const result = await run(['not-base58-because-of-the-hyphens']);

    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('invalid signature format');
  });

  it('a signature of the wrong byte length exits 2 and reports the length', async () => {
    const result = await run(['abc']);

    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('invalid signature length');
    expect(result.stderr).toContain('3 bytes');
  });

  it('an invalid --rpc-url exits 2 and quotes the URL and the expected form', async () => {
    const result = await run([SUCCEEDED.signature, '--rpc-url', 'not a url']);

    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("invalid RPC URL 'not a url'");
    expect(result.stderr).toContain('scheme://host[:port][/path]');
  });

  it('rejects an invalid endpoint from the environment before any request', async () => {
    const result = await run([SUCCEEDED.signature], { env: { OPSIS_RPC_URL: 'http://' } });

    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('invalid RPC URL');
  });

  it('writes every usage diagnostic with the program-name prefix', async () => {
    const result = await run(['abc']);

    expect(result.stderr.startsWith(`${PROGRAM_NAME}: error: `)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --version and --help — Requirements 17.1–17.5, 17.7, 22.6
// ---------------------------------------------------------------------------

describe('--version and --help', () => {
  it('--version writes the package.json version to stdout and exits 0', async () => {
    const result = await run(['--version']);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toBe(`${PACKAGE_VERSION}\n`);
    expect(result.stderr).toBe('');
  });

  it('--help writes syntax, every flag description, and an example to stdout', async () => {
    const result = await run(['--help']);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: opsis <signature> [options]');
    // Requirement 17.3: a description for every flag.
    for (const flag of ['--json', '--rpc-url <url>', '--idl-dir <dir>', '-V, --version', '-h, --help']) {
      expect(result.stdout).toContain(flag);
    }
    // Requirement 17.4: at least one example analyzing a signature.
    expect(result.stdout).toContain(`$ ${PROGRAM_NAME} ${SUCCEEDED.signature}`);
    expect(result.stdout).toContain(DEFAULT_RPC_URL);
  });

  it('--version wins over --help, in either order, and prints only the version', async () => {
    for (const argv of [
      ['--version', '--help'],
      ['--help', '--version'],
      ['-h', '-V'],
    ]) {
      const result = await run(argv);

      expect(result.code).toBe(ExitCode.Success);
      expect(result.stdout).toBe(`${PACKAGE_VERSION}\n`);
      expect(result.stderr).toBe('');
    }
  });

  it('serves --version even when an unrecognized flag is also present', async () => {
    // Requirement 17.1 and Requirement 17.6 both apply to this argv and the
    // requirements do not rank them. commander serves a known option as it
    // encounters it and reports unknown ones only after option parsing, so the
    // version wins — the behavior every mainstream CLI has. Pinned here so the
    // choice is visible rather than incidental.
    const result = await run(['--bogus', '--version', '--help']);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toBe(`${PACKAGE_VERSION}\n`);
    expect(result.stderr).toBe('');
  });

  it('serves --help even when an unrecognized flag is also present', async () => {
    // Same ordering as the case above: an information request is served as it is
    // encountered, and unknown options are reported only afterwards.
    const result = await run(['--bogus', '--help']);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Usage: opsis');
    expect(result.stderr).toBe('');
  });

  it('reports an unrecognized flag when no information flag is present', async () => {
    const result = await run(['--bogus']);

    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown option '--bogus'");
  });

  it('serves --help even though the signature argument is required', async () => {
    const result = await run(['--idl-dir', './idls', '--help']);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Usage: opsis');
    expect(result.stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Analysis, end to end against recorded fixtures — Requirements 10.1, 22.1, 22.2
// ---------------------------------------------------------------------------

describe('analysis against a recorded fixture', () => {
  it('exits 0 and renders to stdout for a transaction that succeeded', async () => {
    const result = await run([SUCCEEDED.signature]);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('TRANSACTION');
    expect(result.stdout).toContain(SUCCEEDED.signature);
    expect(result.stdout).toContain('succeeded');
    expect(result.stdout.endsWith('\n')).toBe(true);
  });

  it('exits 1 and still renders the analysis for a transaction that failed', async () => {
    const result = await run([FAILED.signature]);

    // Exit 1 is a signal, not an error: the analysis is on stdout.
    expect(result.code).toBe(ExitCode.TransactionFailed);
    expect(result.stdout).toContain('failed');
    expect(result.stdout).toContain('failing instruction');
  });

  it('logs the chosen endpoint to stderr and never to stdout', async () => {
    const result = await run([SUCCEEDED.signature]);

    // Requirement 16.7.
    expect(result.stderr).toContain(`using RPC endpoint ${DEFAULT_RPC_URL}`);
    // Requirement 22.6: the piping guarantee.
    expect(result.stdout).not.toContain('using RPC endpoint');
  });

  it('reports the endpoint the flag chose over the environment', async () => {
    const result = await run([SUCCEEDED.signature, '--rpc-url', 'http://127.0.0.1:8899'], {
      env: { OPSIS_RPC_URL: 'http://127.0.0.1:7777' },
    });

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stderr).toContain('using RPC endpoint http://127.0.0.1:8899');
  });

  it('--json puts parseable JSON on stdout and nothing else', async () => {
    const result = await run([FAILED.signature, '--json']);

    expect(result.code).toBe(ExitCode.TransactionFailed);
    // The whole point of `opsis SIG --json | jq`: stdout parses as one document.
    const parsed: unknown = JSON.parse(result.stdout);
    expect((parsed as { readonly signature: string }).signature).toBe(FAILED.signature);
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stderr).toContain('using RPC endpoint');
  });

  it('emits no ANSI escapes when stdout is not a terminal', async () => {
    const result = await run([FAILED.signature], { isTty: false });

    expect(/\u001B\[/u.test(result.stdout)).toBe(false);
  });

  it('reports IDL load warnings to stderr and completes the run anyway', async () => {
    const result = await run([SUCCEEDED.signature, '--idl-dir', 'no-such-idl-dir']);

    // Requirement 18.4: one bad directory degrades decoding, it does not end the
    // run.
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('TRANSACTION');
    expect(result.stderr).toContain(`${PROGRAM_NAME}: warning:`);
    expect(result.stderr).toContain('IDL directory could not be read');
  });
});

// ---------------------------------------------------------------------------
// Fetch and fixture errors — Requirements 2.3, 10.3, 22.4
// ---------------------------------------------------------------------------

describe('fetch and fixture errors exit 3', () => {
  let stub: StubRpcServer;

  beforeAll(async () => {
    // `result: null` is the RPC's "no such transaction" answer (Req 2.3).
    stub = await startStubRpc(() => ({ body: '{"jsonrpc":"2.0","id":1,"result":null}' }));
  });

  afterAll(async () => {
    await stub.close();
  });

  it('a transaction the endpoint does not know exits 3', async () => {
    // No fixture is recorded for this signature, so the RPC source is asked
    // (Req 10.4) — here, a stub on 127.0.0.1.
    const unrecorded = bs58.encode(new Uint8Array(64).fill(7));
    const result = await run([unrecorded, '--rpc-url', stub.url]);

    expect(result.code).toBe(ExitCode.FetchError);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`no transaction found for signature ${unrecorded}`);
  });

  it('a fixture that exists and cannot be parsed exits 3 and names the file', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'opsis-cli-broken-'));
    try {
      await mkdir(join(broken, 'fixtures'));
      const path = join(broken, 'fixtures', `${SUCCEEDED.signature}.json`);
      await writeFile(path, '{ not json', 'utf8');
      const requestsBefore = stub.requests.length;

      const result = await run([SUCCEEDED.signature, '--rpc-url', stub.url], { cwd: broken });

      // Requirement 10.3: no network fallback, and the path is named.
      expect(result.code).toBe(ExitCode.FetchError);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(path);
      expect(result.stderr).toContain('not valid JSON');
      expect(stub.requests.length).toBe(requestsBefore);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });
});
