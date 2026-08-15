/**
 * Narrowing helpers for the source layer's discriminated unions.
 *
 * `expect(x.kind).toBe('loaded')` asserts but does not narrow, so every
 * subsequent field access needs a cast. These throw instead, which both asserts
 * and narrows, and the thrown message carries the value that arrived — a failure
 * says what it got rather than only what it wanted.
 */

import type { RawTransactionResponse } from '../../../src/model/rawResponse.js';
import type { FixtureLookup, SourceError, SourceResult } from '../../../src/source/index.js';

export function expectLookup<K extends FixtureLookup['kind']>(
  lookup: FixtureLookup,
  kind: K,
): Extract<FixtureLookup, { readonly kind: K }> {
  if (lookup.kind !== kind) {
    throw new Error(`expected a ${kind} fixture lookup, got ${JSON.stringify(lookup)}`);
  }
  return lookup as Extract<FixtureLookup, { readonly kind: K }>;
}

export function expectResponse(result: SourceResult): RawTransactionResponse {
  if (!result.ok) {
    throw new Error(`expected a response, got error ${JSON.stringify(result.error)}`);
  }
  return result.response;
}

export function expectError(result: SourceResult): SourceError {
  if (result.ok) {
    throw new Error('expected an error, got a response');
  }
  return result.error;
}
