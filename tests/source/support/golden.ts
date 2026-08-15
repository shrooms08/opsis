/**
 * Read the recorded fixtures under `tests/golden/` as plain documents.
 *
 * These tests need real recorded responses as valid fixture content, and the six
 * committed cases are the only genuine ones available. This helper does nothing
 * but read them.
 *
 * **It is not the golden harness.** That is task 4.10's job: comparing a produced
 * `Analysis` against a pinned `expected.json`, counting pending cases, and
 * failing loudly on a missing one. Nothing here compares anything or looks at
 * `expected.json`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Base58Signature } from '../../../src/model/analysis.js';

const GOLDEN_ROOT = fileURLToPath(new URL('../../golden/', import.meta.url));

export interface GoldenCase {
  readonly name: string;
  /** The signature from `meta.json`, so fixture filenames are real signatures. */
  readonly signature: Base58Signature;
  /** The verbatim recorded bytes of `input.json`. */
  readonly text: string;
  /** Those bytes parsed, for deep-equality assertions. */
  readonly document: unknown;
}

export function goldenCases(): readonly GoldenCase[] {
  return readdirSync(GOLDEN_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const text = readFileSync(join(GOLDEN_ROOT, entry.name, 'input.json'), 'utf8');
      const meta: unknown = JSON.parse(
        readFileSync(join(GOLDEN_ROOT, entry.name, 'meta.json'), 'utf8'),
      );
      const signature = (meta as { readonly signature: Base58Signature }).signature;
      return { name: entry.name, signature, text, document: JSON.parse(text) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** One recorded case, for tests that need a valid response and not a survey. */
export function firstGoldenCase(): GoldenCase {
  const cases = goldenCases();
  const first = cases[0];
  if (first === undefined) {
    throw new Error(`no recorded fixtures found under ${GOLDEN_ROOT}`);
  }
  return first;
}
