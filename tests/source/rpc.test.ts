/**
 * `RpcSource`: the request it sends, and the failures it maps rather than throws.
 *
 * Requirements 2.1, 2.3, 2.4, 2.5, 2.7, 10.5, 16.6.
 *
 * The three genuine network scenarios — a transaction that does not exist, an
 * endpoint that never answers, an endpoint nothing is listening on — run against
 * a real HTTP server on 127.0.0.1, the only host `tests/setup/noNetwork.ts`
 * permits. Real sockets are the point: a substituted `fetch` cannot produce
 * `ECONNREFUSED` or an aborted body read, so the classification of those cases
 * would be asserted against a guess.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { firstGoldenCase } from './support/golden.js';
import { expectError, expectResponse } from './support/narrow.js';
import { RpcSource } from '../../src/source/rpc.js';
import { startStubRpc, type StubRpcServer, unusedPort } from './support/stubRpc.js';

const CASE = firstGoldenCase();

/** Short enough to keep the suite inside its budget; long enough not to be racy. */
const SHORT_TIMEOUT_MS = 150;

let server: StubRpcServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function envelope(result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, result });
}

describe('RpcSource request', () => {
  it('asks getTransaction for the signature with maxSupportedTransactionVersion 0', async () => {
    server = await startStubRpc(() => ({ body: envelope(CASE.document) }));

    await new RpcSource({ endpoint: server.url }).fetch(CASE.signature);

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [CASE.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }],
    });
  });

  it('returns the result member verbatim', async () => {
    server = await startStubRpc(() => ({ body: envelope(CASE.document) }));

    const response = expectResponse(await new RpcSource({ endpoint: server.url }).fetch(CASE.signature));

    expect(response).toEqual(CASE.document);
  });
});

describe('RpcSource failures', () => {
  it('maps a null result to not-found', async () => {
    server = await startStubRpc(() => ({ body: envelope(null) }));

    expect(expectError(await new RpcSource({ endpoint: server.url }).fetch(CASE.signature))).toEqual(
      { kind: 'not-found' },
    );
  });

  it('maps an endpoint that never answers to timeout, carrying the budget applied', async () => {
    server = await startStubRpc(() => 'hang');

    const started = Date.now();
    const error = expectError(
      await new RpcSource({ endpoint: server.url, timeoutMs: SHORT_TIMEOUT_MS }).fetch(
        CASE.signature,
      ),
    );

    expect(error).toEqual({ kind: 'timeout', timeoutMs: SHORT_TIMEOUT_MS });
    // The request was actually cut off rather than the server having replied.
    expect(Date.now() - started).toBeGreaterThanOrEqual(SHORT_TIMEOUT_MS - 20);
  });

  it('maps a refused connection to unreachable, naming the endpoint', async () => {
    const endpoint = `http://127.0.0.1:${await unusedPort()}`;

    const error = expectError(await new RpcSource({ endpoint }).fetch(CASE.signature));

    expect(error).toEqual({ kind: 'unreachable', endpoint });
  });

  it('maps an HTTP error status to a network failure', async () => {
    server = await startStubRpc(() => ({ status: 503, body: 'service unavailable' }));

    const error = expectError(await new RpcSource({ endpoint: server.url }).fetch(CASE.signature));

    expect(error.kind).toBe('network');
    if (error.kind === 'network') expect(error.detail).toContain('503');
  });

  it('maps a JSON-RPC error member to a network failure', async () => {
    server = await startStubRpc(() => ({
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32602, message: 'Invalid param' },
      }),
    }));

    const error = expectError(await new RpcSource({ endpoint: server.url }).fetch(CASE.signature));

    expect(error.kind).toBe('network');
    if (error.kind === 'network') {
      expect(error.detail).toContain('Invalid param');
      expect(error.detail).toContain('-32602');
    }
  });

  it('maps a result that is not a transaction response to a network failure', async () => {
    server = await startStubRpc(() => ({ body: envelope({ slot: 1 }) }));

    const error = expectError(await new RpcSource({ endpoint: server.url }).fetch(CASE.signature));

    expect(error.kind).toBe('network');
    if (error.kind === 'network') expect(error.detail).toContain('blockTime');
  });

  it('maps a body that is not JSON to a network failure', async () => {
    server = await startStubRpc(() => ({ body: '<html>gateway</html>', contentType: 'text/html' }));

    const error = expectError(await new RpcSource({ endpoint: server.url }).fetch(CASE.signature));

    expect(error.kind).toBe('network');
    if (error.kind === 'network') expect(error.detail).toContain('not JSON');
  });
});
