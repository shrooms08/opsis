/**
 * Endpoint and IDL directory configuration.
 *
 * Satisfies Requirement 16 (16.1–16.5) and Requirement 18.1.
 *
 * `resolveConfig` is pure. `env` arrives as a parameter rather than being read
 * from `process.env` here, so the precedence rules are testable without
 * touching the real environment. Nothing in this module writes to a stream or
 * exits the process: an unusable configuration comes back as a `ConfigError`
 * value and `cli.ts` is the single place that turns it into stderr output and
 * exit code 2 (Req 16.5). Req 16.7's "log the chosen endpoint" is likewise
 * `cli.ts`'s job — it reads `rpcUrl` off the resolved config.
 */

/**
 * The parsed command-line surface.
 *
 * The design places this type in `cli.ts`, but `cli.ts` is built later and
 * `config.ts` is the module that consumes it, so the declaration lives here to
 * keep this module compilable on its own. When `cli.ts` is written it MUST
 * import (and may re-export) `CliOptions` from here rather than declaring a
 * second copy — two structurally identical declarations would drift.
 */
export interface CliOptions {
  readonly signature: string;
  readonly json: boolean;
  readonly rpcUrl: string | undefined;
  readonly idlDir: string | undefined;
}

/**
 * Configuration after precedence and validation have been applied. Every
 * downstream module reads its endpoint, directories, and timeout from here.
 */
export interface ResolvedConfig {
  readonly rpcUrl: string;
  readonly idlDir: string | undefined;
  readonly fixtureDir: string;
  readonly requestTimeoutMs: 10_000;
}

/**
 * A configuration that cannot be used. Returned, never thrown.
 *
 * `url` and `expectedForm` are both carried because the Req 16.5 error message
 * has to name the offending URL and the form it failed to match; keeping the
 * message text in `cli.ts` keeps this module free of presentation concerns.
 */
export type ConfigError = {
  readonly kind: 'invalid-rpc-url';
  readonly url: string;
  readonly expectedForm: string;
};

/** Endpoint used when neither the flag nor the environment supplies one (Req 16.2). */
export const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

/** Environment variable consulted when `--rpc-url` is absent (Req 16.3). */
const RPC_URL_ENV_VAR = 'OPSIS_RPC_URL';

/**
 * The one request timeout in Opsis (Req 16.6).
 *
 * Typed as the literal `10_000` so `ResolvedConfig.requestTimeoutMs` cannot be
 * satisfied by any other value. A module that wants a different timeout cannot
 * get one from the config object, which is the point: the type system, not a
 * convention, is what keeps a second timeout out of the codebase.
 */
export const REQUEST_TIMEOUT_MS: 10_000 = 10_000;

/** Fixture lookup root consumed by `FixtureSource` (Req 10.1). */
const DEFAULT_FIXTURE_DIR = './fixtures';

/** Human-readable form quoted back in the Req 16.5 error. */
const RPC_URL_EXPECTED_FORM = 'scheme://host[:port][/path]';

/**
 * `scheme://host[:port][/path]`, and nothing more.
 *
 * Deliberately stricter than `new URL()`, which accepts inputs this grammar
 * does not describe: schemes without `//` (`mailto:a@b`), an empty host
 * (`http://`), userinfo, and a query or fragment. Matching the grammar
 * literally is what lets the accept/reject decision be stated as an
 * equivalence rather than an approximation.
 *
 *   scheme — RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
 *   host   — a bracketed IPv6 literal, or an RFC 3986 reg-name (which covers
 *            DNS names and IPv4 literals); never empty
 *   port   — digits only, range-checked separately
 *   path   — a single leading "/" then path characters; "?" and "#" excluded,
 *            since the grammar has no query or fragment component
 */
const RPC_URL_PATTERN =
  /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._~%!$&'()*+,;=-]+)(?::([0-9]+))?(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/;

const MAX_PORT = 65_535;

/** True when `candidate` conforms to `scheme://host[:port][/path]`. */
function isValidRpcUrl(candidate: string): boolean {
  const match = RPC_URL_PATTERN.exec(candidate);
  if (match === null) return false;

  // The pattern allows any digit run for the port; a port outside 1–65535
  // cannot be connected to, so it is not a valid endpoint either.
  const port = match[1];
  if (port === undefined) return true;

  const portNumber = Number(port);
  return portNumber >= 1 && portNumber <= MAX_PORT;
}

/**
 * Applies endpoint precedence, then validates the winner.
 *
 * Precedence is `--rpc-url` > `OPSIS_RPC_URL` > the mainnet-beta default
 * (Req 16.1–16.4). Validation happens here, before any source layer exists to
 * issue a request, so a malformed endpoint can never reach the network
 * (Req 16.5).
 *
 * An empty `OPSIS_RPC_URL` counts as unset: `OPSIS_RPC_URL=` is the ordinary
 * shell spelling of "not configured", and Req 16.2 sends an unconfigured run to
 * the default. An empty `--rpc-url` is *not* given the same treatment — passing
 * the flag is an explicit act, so the empty value is validated and rejected
 * rather than quietly replaced.
 */
export function resolveConfig(
  options: CliOptions,
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; config: ResolvedConfig } | { ok: false; error: ConfigError } {
  const fromEnv = env[RPC_URL_ENV_VAR];

  const rpcUrl =
    options.rpcUrl !== undefined
      ? options.rpcUrl
      : fromEnv !== undefined && fromEnv !== ''
        ? fromEnv
        : DEFAULT_RPC_URL;

  if (!isValidRpcUrl(rpcUrl)) {
    return {
      ok: false,
      error: {
        kind: 'invalid-rpc-url',
        url: rpcUrl,
        expectedForm: RPC_URL_EXPECTED_FORM,
      },
    };
  }

  return {
    ok: true,
    config: {
      rpcUrl,
      idlDir: options.idlDir,
      fixtureDir: DEFAULT_FIXTURE_DIR,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    },
  };
}
