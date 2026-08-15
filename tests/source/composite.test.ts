/**
 * `CompositeSource`: which source answers, and how many times the other is asked.
 *
 * Requirements 2.6, 2.8, 10.1, 10.3, 10.4, 10.5, 10.6.
 *
 * Two of these assert a call count of zero, and that is the substance rather than
 * a detail. "Prefer the fixture" and "use the fixture and never open a socket"
 * are different behaviors, and only the second gives offline reproducibility; the
 * same goes for a corrupt fixture, where a single quiet fallback would turn a
 * rotted recording into a passing test.
 *
 * The counting stand-in sits at the `TransactionSource` interface, the one seam
 * the design permits substituting at. Nothing inside `src/` is mocked.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Base58Signature } from '../../src/model/analysis.js';
import type { RawTransactionResponse } from '../../src/model/rawResponse.js';
import { CompositeSource } from '../../src/source/composite.js';
import { FixtureSource } from '../../src/source/fixture.js';
import type { SourceResult, TransactionSource } from '../../src/source/index.js';
import { RpcSource } from '../../src/source/rpc.js';
import { firstGoldenCase } from './support/golden.js';
import { expectError, expectResponse } from './support/narrow.js';
import { startStubRpc, type StubRpcServer } from './support/stubRpc.js';

const CASE = firstGoldenCase();

/** Records every call so a test can assert exactly-once and exactly-zero. */
class CountingSource implements TransactionSource {
  readonly calls: Base58Signature[] = [];
  private readonly result: SourceResult;

  constructor(result: SourceResult) {
    this.result = result;
  }

  async fetch(signature: Base58Signature): Promise<SourceResult> {
    this.calls.push(signature);
    return this.result;
  }
}

const NOT_FOUND: SourceResult = { ok: false, error: { kind: 'not-found' } };

let fixtureDir: string;

beforeEach(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'opsis-composite-'));
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function writeFixture(content: string): Promise<string> {
  const path = join(fixtureDir, `${CASE.signature}.json`);
  await writeFile(path, content);
  return path;
}

function composite(rpc: TransactionSource): CompositeSource {
  return new CompositeSource(new FixtureSource(fixtureDir), rpc);
}

describe('CompositeSource', () => {
  it('falls through to the RPC source exactly once when no fixture exists', async () => {
    const rpc = new CountingSource(NOT_FOUND);

    const result = await composite(rpc).fetch(CASE.signature);

    expect(rpc.calls).toEqual([CASE.signature]);
    // The RPC source's answer is passed back untouched, failure included.
    expect(result).toEqual(NOT_FOUND);
  });

  it('uses a loadable fixture and never asks the RPC source', async () => {
    await writeFixture(CASE.text);
    const rpc = new CountingSource(NOT_FOUND);

    const response = expectResponse(await composite(rpc).fetch(CASE.signature));

    expect(response).toEqual(CASE.document);
    expect(rpc.calls).toEqual([]);
  });

  it('fails with fixture-unreadable and never asks the RPC source when a fixture is broken', async () => {
    const path = await writeFixture(CASE.text.slice(0, 100));
    const rpc = new CountingSource(NOT_FOUND);

    const error = expectError(await composite(rpc).fetch(CASE.signature));

    expect(error.kind).toBe('fixture-unreadable');
    expect(error).toMatchObject({ path });
    expect(rpc.calls).toEqual([]);
  });

  it('would have succeeded on the network, and still refuses a broken fixture', async () => {
    // The point of the pairing: the same signature that a live endpoint answers
    // perfectly well is reported as a failure once a fixture exists and is
    // corrupt. Nothing about network availability changes the outcome.
    const path = await writeFixture('{ truncated');
    const rpc = new CountingSource({
      ok: true,
      response: CASE.document as RawTransactionResponse,
    });

    const error = expectError(await composite(rpc).fetch(CASE.signature));

    expect(error).toMatchObject({ kind: 'fixture-unreadable', path });
    expect(rpc.calls).toEqual([]);
  });
});

describe('CompositeSource over a live endpoint', () => {
  let server: StubRpcServer;

  afterEach(async () => {
    await server.close();
  });

  it('returns a document from the network identical to the one from a fixture', async () => {
    server = await startStubRpc(() => ({
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: CASE.document }),
    }));

    const fromNetwork = expectResponse(
      await composite(new RpcSource({ endpoint: server.url })).fetch(CASE.signature),
    );

    await writeFixture(CASE.text);
    const fromFixture = expectResponse(
      await composite(new CountingSource(NOT_FOUND)).fetch(CASE.signature),
    );

    // The two sources are interchangeable: same document in, deep-equal document
    // out, with no field recording where it came from (Req 2.7, 10.5).
    expect(fromNetwork).toEqual(fromFixture);
    expect(fromNetwork).toEqual(CASE.document);
  });
});
