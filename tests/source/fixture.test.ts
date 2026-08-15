/**
 * `FixtureSource`: absence, verbatim loading, and the ways a fixture can be broken.
 *
 * Requirements 10.1, 10.2, 10.3, 10.5, 2.6, 2.8.
 *
 * The three-way split is the behavior under test. Absence and unreadability are
 * separate outcomes, and every unreadable variety — bad bytes, bad JSON, a
 * document that is not a transaction response, an unopenable file — has to land
 * on `unreadable` with a path and a reason rather than being mistaken for
 * absence, because the composite decides whether to touch the network from
 * exactly that distinction.
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FixtureSource } from '../../src/source/fixture.js';
import { firstGoldenCase, goldenCases } from './support/golden.js';
import { expectError, expectLookup, expectResponse } from './support/narrow.js';

/** Any string works as a filename; this one is a real recorded signature. */
const CASE = firstGoldenCase();

let fixtureDir: string;
let source: FixtureSource;

beforeEach(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'opsis-fixture-'));
  source = new FixtureSource(fixtureDir);
});

afterEach(async () => {
  // force so a chmod-ed file cannot leave a temp directory behind.
  await chmod(fixtureDir, 0o700).catch(() => undefined);
  await rm(fixtureDir, { recursive: true, force: true });
});

/** Write `content` where the source will look for `signature`. */
async function writeFixture(signature: string, content: string | Uint8Array): Promise<string> {
  const path = join(fixtureDir, `${signature}.json`);
  await writeFile(path, content);
  return path;
}

describe('FixtureSource.load', () => {
  it('reports absence, with the path it looked at, when no file exists', async () => {
    const lookup = expectLookup(await source.load(CASE.signature), 'absent');

    expect(lookup.path).toBe(join(fixtureDir, `${CASE.signature}.json`));
  });

  it('loads every recorded fixture verbatim', async () => {
    for (const recorded of goldenCases()) {
      await writeFixture(recorded.signature, recorded.text);

      const lookup = expectLookup(await source.load(recorded.signature), 'loaded');

      // Deep equality against the parsed file, not against a hand-written
      // expectation: the assertion is that nothing was added, dropped, renamed,
      // or re-encoded on the way through (Req 10.5).
      expect(lookup.response).toEqual(recorded.document);
    }
  });

  it('does not treat a fixture directory it cannot find as unreadable', async () => {
    const missing = new FixtureSource(join(fixtureDir, 'no', 'such', 'directory'));

    expect(expectLookup(await missing.load(CASE.signature), 'absent')).toBeDefined();
  });

  describe('reports a present-but-broken fixture as unreadable', () => {
    it('when the JSON is truncated', async () => {
      const path = await writeFixture(CASE.signature, CASE.text.slice(0, CASE.text.length - 40));

      const lookup = expectLookup(await source.load(CASE.signature), 'unreadable');

      expect(lookup.path).toBe(path);
      expect(lookup.detail).toContain('not valid JSON');
    });

    it('when the root is the wrong type', async () => {
      await writeFixture(CASE.signature, '[]');

      const lookup = expectLookup(await source.load(CASE.signature), 'unreadable');

      expect(lookup.detail).toContain('array');
    });

    it('when a required top-level field is missing', async () => {
      const withoutMeta: Record<string, unknown> = {
        ...(CASE.document as Record<string, unknown>),
      };
      delete withoutMeta['meta'];
      await writeFixture(CASE.signature, JSON.stringify(withoutMeta));

      const lookup = expectLookup(await source.load(CASE.signature), 'unreadable');

      expect(lookup.detail).toContain('"meta" is missing');
    });

    it('when the bytes are not UTF-8', async () => {
      // Structurally valid JSON whose string payload is invalid UTF-8. The
      // lenient decoder would substitute U+FFFD and this file would parse,
      // leaving corrupted content to look intact.
      const corrupt = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
      await writeFixture(CASE.signature, corrupt);

      const lookup = expectLookup(await source.load(CASE.signature), 'unreadable');

      expect(lookup.detail).toContain('not valid UTF-8');
    });

    it('when a directory sits where the file should be', async () => {
      await mkdir(join(fixtureDir, `${CASE.signature}.json`));

      const lookup = expectLookup(await source.load(CASE.signature), 'unreadable');

      expect(lookup.detail).toContain('EISDIR');
    });

    // Root ignores the permission bits, so the case cannot be produced there.
    it.skipIf(process.getuid?.() === 0)('when the file cannot be opened', async () => {
      const path = await writeFixture(CASE.signature, CASE.text);
      await chmod(path, 0o000);

      const lookup = expectLookup(await source.load(CASE.signature), 'unreadable');

      expect(lookup.path).toBe(path);
      expect(lookup.detail).toContain('EACCES');
    });
  });
});

describe('FixtureSource.fetch', () => {
  it('answers a recorded fixture with the response', async () => {
    await writeFixture(CASE.signature, CASE.text);

    expect(expectResponse(await source.fetch(CASE.signature))).toEqual(CASE.document);
  });

  it('answers an absent fixture with not-found, since there is nowhere else to ask', async () => {
    expect(expectError(await source.fetch(CASE.signature))).toEqual({ kind: 'not-found' });
  });

  it('answers a broken fixture with fixture-unreadable, naming the file and the reason', async () => {
    const path = await writeFixture(CASE.signature, 'not json at all');

    const error = expectError(await source.fetch(CASE.signature));

    expect(error.kind).toBe('fixture-unreadable');
    expect(error).toMatchObject({ path });
    if (error.kind === 'fixture-unreadable') {
      expect(error.detail).not.toBe('');
    }
  });
});
