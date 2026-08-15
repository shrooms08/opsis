/**
 * `RpcSource` — fetch one transaction from a live endpoint. Requirements 2.1–2.5, 2.7, 16.6.
 *
 * Exactly one read-only RPC call, `getTransaction`, for the one signature the
 * user typed, with `maxSupportedTransactionVersion: 0` so a v0 message comes back
 * rather than an "unsupported version" error. No enumeration, no construction, no
 * signing, no simulation, no retry.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ISSUES THE JSON-RPC CALL ITSELF INSTEAD OF USING `@solana/web3.js`
 *
 * design.md says this module calls `getTransaction` "through `@solana/web3.js`".
 * It calls the `getTransaction` RPC method with the parameters design.md
 * specifies, but it does so over `fetch` directly, and that is a knowing
 * deviation rather than an oversight. Two reasons, either of which is decisive:
 *
 * 1. `Connection.getTransaction` does not return the RPC JSON. It returns a
 *    web3.js object: `transaction.message` becomes a `Message`/`VersionedMessage`
 *    instance, `accountKeys` becomes `PublicKey` objects, and compiled
 *    instruction data becomes `Uint8Array`. Handing that to the pipeline would
 *    require reconstructing the wire shape field by field — which is exactly the
 *    normalization design.md forbids the source layer from doing, and it would
 *    put a hand-written transformation on the live path and none on the fixture
 *    path. Property 6 (fixture and live yield deep-equal `Analysis`) would then
 *    rest on that transformation being perfect, and `RawTransactionResponse`
 *    would no longer be "a structural type over the RPC JSON shape, not a
 *    web3.js class" (Req 10.5).
 *
 * 2. `Connection` accepts no per-request `AbortSignal`. The 10-second budget of
 *    Requirements 2.1/2.5 could only be imposed by injecting a custom `fetch`
 *    into `ConnectionConfig` — i.e. by going through `fetch` anyway, with a
 *    class in between that then has to be undone.
 *
 * The request this sends is byte-identical in method and params to the one
 * `scripts/recordFixture.ts` sends, `encoding` left unset so the endpoint applies
 * its default. The recorded fixtures are therefore the same documents a live run
 * receives, which is the concrete thing Property 6 rests on.
 *
 * `@solana/web3.js` remains a dependency and is used where it earns its place —
 * account and instruction decoding — but not as an HTTP client whose output would
 * have to be converted back into what it was.
 * ---------------------------------------------------------------------------
 *
 * Every failure is mapped to a typed `SourceError`. Nothing here throws, writes
 * to a stream, or exits.
 */

import { REQUEST_TIMEOUT_MS } from '../config.js';
import type { Base58Signature } from '../model/analysis.js';
import {
  asTransactionResponse,
  type SourceError,
  type SourceResult,
  type TransactionSource,
} from './index.js';

export interface RpcSourceOptions {
  /** Already validated by `resolveConfig`, so no request is issued at a bad URL. */
  readonly endpoint: string;
  /**
   * Request budget in milliseconds. Defaults to `REQUEST_TIMEOUT_MS`, the single
   * timeout value in Opsis.
   *
   * Typed `number` rather than the literal `10_000` only so a test can use a
   * short budget instead of stalling a suite for ten seconds. The production
   * path cannot introduce a second timeout regardless: `cli.ts` passes
   * `ResolvedConfig.requestTimeoutMs`, whose type *is* the literal `10_000`, so
   * there is no other value it could supply.
   */
  readonly timeoutMs?: number;
}

/**
 * errno codes that mean the endpoint was never reached: connection refused, name
 * not resolved, no route. Requirement 16.6 treats these as one condition —
 * "cannot be reached" — distinct from a request that reached a server and then
 * failed (Req 2.4), because the remedy is different: check the URL, not the
 * transaction.
 */
const UNREACHABLE_CODES: readonly string[] = [
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
];

/**
 * `AbortSignal.timeout` aborts with a `TimeoutError`; some `fetch` builds
 * substitute a generic `AbortError`. Either way this module creates no other
 * signal, so any abort is our own timeout firing.
 */
const ABORT_NAMES: readonly string[] = ['TimeoutError', 'AbortError'];

/** JSON-RPC requires an id; the value is arbitrary for a single call. */
const JSON_RPC_ID = 1;

/**
 * Walk an error's `cause` chain (and any `AggregateError.errors`) for an errno
 * code. `fetch` reports a refused connection as `TypeError: fetch failed` with
 * the real `ECONNREFUSED` nested one or two levels down, so reading only the
 * top-level error would classify every transport failure as generic.
 */
function errnoOf(cause: unknown, depth = 0): string | null {
  if (typeof cause !== 'object' || cause === null || depth > 4) return null;

  const code = (cause as { readonly code?: unknown }).code;
  if (typeof code === 'string') return code;

  if (cause instanceof AggregateError) {
    for (const inner of cause.errors) {
      const found = errnoOf(inner, depth + 1);
      if (found !== null) return found;
    }
  }

  return errnoOf((cause as { readonly cause?: unknown }).cause, depth + 1);
}

/**
 * A transport failure as one line, following the `cause` chain so the useful part
 * is not hidden behind `fetch failed`. Diagnostic text only; nothing branches on
 * it.
 */
function describeCause(cause: unknown, depth = 0): string {
  if (!(cause instanceof Error)) return String(cause);
  const nested: unknown = (cause as { readonly cause?: unknown }).cause;
  if (depth < 4 && nested instanceof Error && nested.message !== cause.message) {
    return `${cause.message}: ${describeCause(nested, depth + 1)}`;
  }
  return cause.message;
}

/** A plain JSON object, or null for anything else including arrays and null. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

/** A JSON-RPC error member as readable text, whatever shape it arrived in. */
function describeRpcError(error: unknown): string {
  const record = asRecord(error);
  if (record === null) return String(error);
  const code = record['code'];
  const message = record['message'];
  const codePart = typeof code === 'number' ? ` (code ${code})` : '';
  const messagePart = typeof message === 'string' ? message : JSON.stringify(error);
  return `${messagePart}${codePart}`;
}

export class RpcSource implements TransactionSource {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(options: RpcSourceOptions) {
    this.endpoint = options.endpoint;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async fetch(signature: Base58Signature): Promise<SourceResult> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: JSON_RPC_ID,
      method: 'getTransaction',
      params: [signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }],
    });

    // One signal for headers and body together: the Requirement 2.1 budget is on
    // the whole request, so an endpoint that answers instantly and then dribbles
    // the body must still be cut off at the limit.
    const signal = AbortSignal.timeout(this.timeoutMs);

    let text: string;
    try {
      // Read off `globalThis` at call time rather than captured at module load,
      // so the test suite's network interceptor is in force for this call.
      const response = await globalThis.fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      });

      if (!response.ok) {
        const status =
          response.statusText === '' ? `${response.status}` : `${response.status} ${response.statusText}`;
        return {
          ok: false,
          error: {
            kind: 'network',
            detail: `the endpoint at ${this.endpoint} answered HTTP ${status}`,
          },
        };
      }

      text = await response.text();
    } catch (cause) {
      return { ok: false, error: this.classifyTransportFailure(cause) };
    }

    return this.readEnvelope(text);
  }

  /**
   * Sort a thrown transport failure into the three variants that describe one.
   *
   * Order matters: an abort is checked first because an aborted request may also
   * surface an errno from the socket it tore down, and the timeout is the
   * accurate account of what happened.
   */
  private classifyTransportFailure(cause: unknown): SourceError {
    if (cause instanceof Error && ABORT_NAMES.includes(cause.name)) {
      return { kind: 'timeout', timeoutMs: this.timeoutMs };
    }

    const code = errnoOf(cause);
    if (code !== null && UNREACHABLE_CODES.includes(code)) {
      return { kind: 'unreachable', endpoint: this.endpoint };
    }

    return { kind: 'network', detail: describeCause(cause) };
  }

  /**
   * Unwrap the JSON-RPC envelope and hand back the `result` member untouched.
   *
   * `result: null` is the not-found signal (Req 2.3) and is the one case here
   * that is not a malfunction. Everything else that is not a usable response —
   * an unparseable body, a JSON-RPC error member, a missing `result`, a result
   * that is not a `getTransaction` response — is a `network` failure: the request
   * reached a server and the server did not answer the question.
   */
  private readEnvelope(text: string): SourceResult {
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch (cause) {
      return {
        ok: false,
        error: {
          kind: 'network',
          detail: `the endpoint at ${this.endpoint} answered with a body that is not JSON: ${describeCause(cause)}`,
        },
      };
    }

    const root = asRecord(envelope);
    if (root === null) {
      return {
        ok: false,
        error: {
          kind: 'network',
          detail: `the endpoint at ${this.endpoint} answered with a JSON-RPC response that is not an object`,
        },
      };
    }

    const rpcError = root['error'];
    if (rpcError !== undefined && rpcError !== null) {
      return {
        ok: false,
        error: {
          kind: 'network',
          detail: `getTransaction failed at ${this.endpoint}: ${describeRpcError(rpcError)}`,
        },
      };
    }

    if (!('result' in root)) {
      return {
        ok: false,
        error: {
          kind: 'network',
          detail: `the endpoint at ${this.endpoint} answered with neither a result nor an error`,
        },
      };
    }

    const result = root['result'];
    if (result === null) {
      return { ok: false, error: { kind: 'not-found' } };
    }

    const checked = asTransactionResponse(result);
    if (!checked.ok) {
      return {
        ok: false,
        error: {
          kind: 'network',
          detail: `the endpoint at ${this.endpoint} returned a result that is not a getTransaction response: ${checked.detail}`,
        },
      };
    }

    // Verbatim: the parsed `result` member, with nothing added or renamed.
    return { ok: true, response: checked.response };
  }
}
