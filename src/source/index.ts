/**
 * The transaction source seam. Satisfies Requirements 2, 10, 16.6.
 *
 * One interface, two implementations (`./fixture.js`, `./rpc.js`), and a
 * composite (`./composite.js`) that sequences them.
 *
 * Two invariants govern everything in this directory:
 *
 * 1. **Nothing is normalized.** A source hands back the `getTransaction` result
 *    exactly as it arrived, so a fixture file and a live response are literally
 *    the same input (Req 10.5) and the pipeline cannot tell them apart. Nothing
 *    downstream records provenance either, which is what makes design.md's
 *    Property 6 — fixture and live produce deep-equal `Analysis` objects —
 *    stateable at all.
 * 2. **Nothing throws, nothing writes, nothing exits.** Every failure comes back
 *    as a `SourceError` value. Turning one into a stderr message and exit code 3
 *    belongs to `cli.ts` and `exit.ts`.
 *
 * This module holds only types and one pure guard, so it imports no I/O.
 */

import type { Base58Signature } from '../model/analysis.js';
import type { RawTransactionResponse } from '../model/rawResponse.js';

/**
 * Somewhere a transaction response can be obtained from.
 *
 * `FixtureSource`, `RpcSource`, and `CompositeSource` all implement it, which is
 * the single substitution point in the whole system: the golden harness swaps a
 * `FixtureSource` in for an `RpcSource` here and every module below runs exactly
 * as it does in production, unmocked.
 */
export interface TransactionSource {
  fetch(signature: Base58Signature): Promise<SourceResult>;
}

export type SourceResult =
  | { readonly ok: true; readonly response: RawTransactionResponse }
  | { readonly ok: false; readonly error: SourceError };

/**
 * Why a fetch produced no response.
 *
 * The five variants are the five rows of design.md's error table that name a
 * source module, and each maps to exit code 3:
 *
 * - `not-found` — the signature does not name a transaction (Req 2.3).
 * - `network` — the request failed, or the endpoint answered something that is
 *   not a `getTransaction` response (Req 2.4). `detail` is diagnostic text, not
 *   a stable identifier; nothing branches on it.
 * - `timeout` — the request outlived its budget and was aborted (Req 2.1, 2.5).
 *   `timeoutMs` is carried rather than assumed so the message can quote the
 *   limit that was actually applied.
 * - `unreachable` — the endpoint could not be connected to at all: refused,
 *   unresolvable, or no route (Req 16.6).
 * - `fixture-unreadable` — a fixture file existed and could not be loaded
 *   (Req 2.8, 10.3). Carries the path and the reason, because a corrupt fixture
 *   is a maintainer's problem and they need to know which file and why.
 */
export type SourceError =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'network'; readonly detail: string }
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  | { readonly kind: 'unreachable'; readonly endpoint: string }
  | { readonly kind: 'fixture-unreadable'; readonly path: string; readonly detail: string };

/**
 * What looking for a fixture found. Three outcomes, not two.
 *
 * This type exists because `SourceResult` cannot express the distinction
 * Requirements 2.6/2.8 and 10.3/10.4 turn on. **Absent and unreadable are
 * different outcomes**: absence means "no fixture was recorded for this
 * signature, ask the network", while unreadability means "a fixture was
 * recorded, and it is broken — stop." Collapsing them would let a corrupt
 * fixture silently fall through to a live request, which destroys offline
 * reproducibility and makes a corrupt fixture look like a passing test.
 *
 * Keeping the two apart in the *type* rather than in a shared error `kind` is
 * what makes `CompositeSource`'s branch exhaustive rather than conventional.
 */
export type FixtureLookup =
  | { readonly kind: 'absent'; readonly path: string }
  | {
      readonly kind: 'loaded';
      readonly path: string;
      readonly response: RawTransactionResponse;
    }
  | { readonly kind: 'unreadable'; readonly path: string; readonly detail: string };

/**
 * The fixture-shaped half of `FixtureSource`, split out so `CompositeSource`
 * depends on the three-outcome lookup and not on a concrete class.
 */
export interface FixtureLoader {
  load(signature: Base58Signature): Promise<FixtureLookup>;
}

/** What a value is, for a diagnostic. `typeof` alone calls null and arrays objects. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** A plain JSON object, or null for anything else including arrays and null. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

export type ResponseCheck =
  | { readonly ok: true; readonly response: RawTransactionResponse }
  | { readonly ok: false; readonly detail: string };

/**
 * Is this document a `getTransaction` response at all?
 *
 * **This is a guard on a cast, not a validation pass and not a normalization
 * step.** It returns the very object it was handed, unchanged; it exists only
 * because `RawTransactionResponse` declares `slot`, `blockTime`, `transaction`,
 * and `meta` as non-optional, and casting an arbitrary parsed document to that
 * type would make the type lie. So the check covers exactly the non-optional
 * surface of the root plus `RawTransaction`, and stops there.
 *
 * It stops there on purpose. Everything deeper — account keys, headers,
 * instruction data, balances — is read by `decode/` and `resolve/`, which are
 * written against untrusted values and degrade honestly when a field is missing
 * or malformed. Checking those here would add no safety and would risk
 * rejecting a real response from a node whose output differs in some corner
 * from the six recorded fixtures.
 *
 * Fixture loading and live fetching both route through this one function, so
 * the two paths accept and reject identically. That symmetry is a precondition
 * of Property 6: if the fixture path were stricter, a document could analyze
 * live and fail offline.
 */
export function asTransactionResponse(document: unknown): ResponseCheck {
  const root = asRecord(document);
  if (root === null) {
    return {
      ok: false,
      detail: `expected a JSON object at the document root, found ${typeName(document)}`,
    };
  }

  if (typeof root['slot'] !== 'number') {
    return { ok: false, detail: `"slot" must be a number, found ${typeName(root['slot'])}` };
  }

  // Present-and-nullable, not optional: the RPC always sends the key, and a
  // node with no block time for the slot sends an explicit null.
  if (!('blockTime' in root)) {
    return { ok: false, detail: '"blockTime" is missing' };
  }
  const blockTime = root['blockTime'];
  if (blockTime !== null && typeof blockTime !== 'number') {
    return {
      ok: false,
      detail: `"blockTime" must be a number or null, found ${typeName(blockTime)}`,
    };
  }

  // Also present-and-nullable. A null `meta` is a legitimate response with no
  // balances, no logs, and no lookup resolution to read; an absent key is not.
  if (!('meta' in root)) {
    return { ok: false, detail: '"meta" is missing' };
  }
  const meta = root['meta'];
  if (meta !== null && asRecord(meta) === null) {
    return { ok: false, detail: `"meta" must be an object or null, found ${typeName(meta)}` };
  }

  const transaction = asRecord(root['transaction']);
  if (transaction === null) {
    return {
      ok: false,
      detail: `"transaction" must be an object, found ${typeName(root['transaction'])}`,
    };
  }
  if (asRecord(transaction['message']) === null) {
    return {
      ok: false,
      detail: `"transaction.message" must be an object, found ${typeName(transaction['message'])}`,
    };
  }
  if (!Array.isArray(transaction['signatures'])) {
    return {
      ok: false,
      detail: `"transaction.signatures" must be an array, found ${typeName(transaction['signatures'])}`,
    };
  }

  return { ok: true, response: document as RawTransactionResponse };
}
