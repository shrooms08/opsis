/**
 * Offline enforcement for the entire test suite (Requirements 9.4, 10.6, 14.9).
 *
 * Wired as a vitest `setupFiles` entry, so it runs before every test file. It
 * patches both network paths a test can reach: `globalThis.fetch`, which Node's
 * built-in fetch serves without touching the `http` module, and
 * `http`/`https` `request`/`get`, which `@solana/web3.js` reaches through its
 * own fetch polyfill. Patching only one would leave the other open.
 *
 * The point is that offline is *enforced* rather than assumed. A test that
 * accidentally reaches the network fails here, on every machine, instead of
 * passing where there is connectivity and failing in review where there is not.
 */
import { afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';

/**
 * The one host tests may reach: the loopback literal, and nothing else.
 *
 * Task 4.4 stands up a local stub server for the three genuine network
 * scenarios (timeout, connection refused, transaction not found). Those are the
 * only tests permitted through.
 *
 * `localhost` is deliberately *not* allowed, even though it usually resolves
 * here. It is a name, not an address: it can resolve to `::1`, or through
 * `/etc/hosts` or DNS to something else entirely, so allowing it would make the
 * allowlist depend on host configuration. Requiring the literal keeps the check
 * on an address. Point stub-server tests at `http://127.0.0.1:<port>`.
 */
const ALLOWED_HOST = '127.0.0.1';

/** Node's default host when request options name none. Not on the allowlist. */
const IMPLICIT_HOST = 'localhost';

class NetworkAccessError extends Error {
  constructor(target: string, host: string) {
    super(
      `Outbound network request attempted during a test: ${target} ` +
        `(host: ${host}). The Opsis test suite is required to run with no ` +
        `network — only ${ALLOWED_HOST} is allowed, for the local stub server. ` +
        `Use a recorded fixture instead of a live endpoint, or point the ` +
        `request at ${ALLOWED_HOST}. See tests/setup/noNetwork.ts.`,
    );
    this.name = 'NetworkAccessError';
  }
}

/**
 * Resolve a host from a URL or bare authority.
 *
 * The allowlist check runs on this resolved host, never on a substring of the
 * URL, so `http://127.0.0.1.evil.example/` resolves to
 * `127.0.0.1.evil.example` and is blocked.
 */
function hostOf(value: string, scheme: string): string | null {
  try {
    const url = value.includes('://')
      ? new URL(value)
      : new URL(`${scheme}://${value}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function assertAllowed(target: string, host: string | null): void {
  if (host !== ALLOWED_HOST) {
    throw new NetworkAccessError(target, host ?? '<unparseable>');
  }
}

/* -------------------------------------------------------------------------- */
/* fetch                                                                      */
/* -------------------------------------------------------------------------- */

function fetchTarget(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof input === 'object' && input !== null && 'url' in input) {
    const { url } = input as { url: unknown };
    if (typeof url === 'string') return url;
  }
  return String(input);
}

const realFetch = globalThis.fetch;

type FetchArgs = Parameters<typeof globalThis.fetch>;

globalThis.fetch = ((input: FetchArgs[0], init?: FetchArgs[1]) => {
  const target = fetchTarget(input);
  const host = hostOf(target, 'https');
  if (host !== ALLOWED_HOST) {
    // Reject rather than throw synchronously, so the failure arrives the way a
    // real fetch failure would and `await`/`.rejects` assertions still work.
    return Promise.reject(new NetworkAccessError(target, host ?? '<unparseable>'));
  }
  return realFetch(input, init);
}) as typeof globalThis.fetch;

/* -------------------------------------------------------------------------- */
/* http / https                                                               */
/* -------------------------------------------------------------------------- */

type AnyRequest = (...args: readonly unknown[]) => unknown;

function asOptions(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !(value instanceof URL)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Describe what a `request`/`get` call is trying to reach.
 *
 * Both accept `(options)`, `(url)`, and `(url, options)`; when both are given,
 * options win, which is why later arguments overwrite earlier ones here.
 */
function describeAttempt(
  args: readonly unknown[],
  scheme: 'http' | 'https',
): { host: string; target: string } {
  let host = IMPLICIT_HOST;
  let port = '';
  let path = '';

  for (const arg of args) {
    if (typeof arg === 'string' || arg instanceof URL) {
      const url = arg instanceof URL ? arg : tryUrl(arg);
      if (url !== null) {
        host = url.hostname;
        port = url.port;
        path = `${url.pathname}${url.search}`;
      }
      continue;
    }

    const options = asOptions(arg);
    if (options === null) continue;

    const named = options['hostname'] ?? options['host'];
    if (typeof named === 'string') {
      // `host` may carry a port; parse it rather than splitting on ':'.
      const resolved = hostOf(named, scheme);
      host = resolved ?? named;
      const withPort = tryUrl(`${scheme}://${named}`);
      if (withPort !== null && withPort.port !== '') port = withPort.port;
    }
    const explicitPort = options['port'];
    if (typeof explicitPort === 'string' || typeof explicitPort === 'number') {
      port = String(explicitPort);
    }
    if (typeof options['path'] === 'string') path = options['path'];
  }

  const authority = port === '' ? host : `${host}:${port}`;
  return { host, target: `${scheme}://${authority}${path}` };
}

function tryUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function guarded(original: AnyRequest, scheme: 'http' | 'https'): AnyRequest {
  return (...args: readonly unknown[]) => {
    const { host, target } = describeAttempt(args, scheme);
    assertAllowed(target, host);
    return original(...args);
  };
}

interface RequestModule {
  request: AnyRequest;
  get: AnyRequest;
}

/**
 * `http.get` calls the module's internal `request`, not the exported one, so
 * both entry points need patching.
 */
function patch(module: RequestModule, scheme: 'http' | 'https'): () => void {
  const originalRequest = module.request;
  const originalGet = module.get;
  module.request = guarded(originalRequest, scheme);
  module.get = guarded(originalGet, scheme);
  return () => {
    module.request = originalRequest;
    module.get = originalGet;
  };
}

const restoreHttp = patch(http as unknown as RequestModule, 'http');
const restoreHttps = patch(https as unknown as RequestModule, 'https');

/** Leave the process as we found it, so nothing leaks between test files. */
afterAll(() => {
  globalThis.fetch = realFetch;
  restoreHttp();
  restoreHttps();
});
