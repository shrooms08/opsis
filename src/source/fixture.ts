/**
 * `FixtureSource` — read a recorded response from disk. Requirements 10.1–10.3, 2.6, 2.8.
 *
 * Reads `<fixtureDir>/<signature>.json`, which holds the verbatim recorded
 * `getTransaction` result as written by `scripts/recordFixture.ts`. The file is
 * the *result* object, not the JSON-RPC envelope, so what comes out of here is
 * byte-for-byte the same document `RpcSource` pulls out of a live response.
 *
 * The class deliberately exposes two entry points over one implementation:
 *
 * - `load` answers the three-outcome `FixtureLookup`, which is what
 *   `CompositeSource` needs in order to keep absence and unreadability apart.
 * - `fetch` satisfies `TransactionSource` for the standalone offline case (the
 *   golden harness), where "no fixture for this signature" is simply
 *   `not-found`.
 *
 * The path is composed from the signature without sanitizing it, and that is
 * safe rather than sloppy: `validateSignature` in `../signature.ts` has already
 * base58-decoded the value, and the base58 alphabet contains no `/`, no `\`, and
 * no `.`, so a validated signature cannot name anything outside `fixtureDir`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Base58Signature } from '../model/analysis.js';
import {
  asTransactionResponse,
  type FixtureLoader,
  type FixtureLookup,
  type SourceResult,
  type TransactionSource,
} from './index.js';

/**
 * errno codes that mean "there is no such file", as opposed to "there is one and
 * it cannot be read".
 *
 * `ENOENT` is the ordinary absence. `ENOTDIR` is absence too: it says a path
 * component that should have been a directory is a file, so nothing can exist at
 * the full path. Every other errno — `EACCES`, `EISDIR`, `EIO`, `ELOOP`,
 * `EMFILE` — describes a fixture that exists in some form and could not be read,
 * which Requirement 10.3 makes a hard failure with no network fallback.
 */
const ABSENCE_CODES: readonly string[] = ['ENOENT', 'ENOTDIR'];

/**
 * Strict UTF-8. `fatal: true` is the point: the lenient decoder substitutes
 * U+FFFD for invalid bytes, which can leave a corrupt file parsing as
 * well-formed JSON with silently mangled strings. Requirement 10.3 names file
 * corruption explicitly, and this is the branch that catches the non-UTF-8 kind.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The errno code of a filesystem rejection, or null when it carries none. */
function errnoOf(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) return null;
  const code = (cause as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class FixtureSource implements TransactionSource, FixtureLoader {
  private readonly fixtureDir: string;

  constructor(fixtureDir: string) {
    this.fixtureDir = fixtureDir;
  }

  /** The file a signature would be recorded in. The only place this name is built. */
  pathFor(signature: Base58Signature): string {
    return join(this.fixtureDir, `${signature}.json`);
  }

  /**
   * Look for a recorded response.
   *
   * Four distinct ways to be unreadable are collapsed into one outcome carrying
   * a reason, because they all mean the same thing to the caller — a fixture was
   * recorded and cannot be trusted — while the reason is what a maintainer
   * needs: an unreadable file, invalid UTF-8, invalid JSON, or a document that
   * is not a `getTransaction` response.
   */
  async load(signature: Base58Signature): Promise<FixtureLookup> {
    const path = this.pathFor(signature);

    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch (cause) {
      const code = errnoOf(cause);
      if (code !== null && ABSENCE_CODES.includes(code)) {
        return { kind: 'absent', path };
      }
      return { kind: 'unreadable', path, detail: messageOf(cause) };
    }

    let text: string;
    try {
      text = UTF8.decode(bytes);
    } catch (cause) {
      return {
        kind: 'unreadable',
        path,
        detail: `the file is not valid UTF-8: ${messageOf(cause)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      return { kind: 'unreadable', path, detail: `the file is not valid JSON: ${messageOf(cause)}` };
    }

    const checked = asTransactionResponse(parsed);
    if (!checked.ok) {
      return {
        kind: 'unreadable',
        path,
        detail: `the file is not a getTransaction response: ${checked.detail}`,
      };
    }

    // Returned verbatim. Nothing between JSON.parse and here touched the value.
    return { kind: 'loaded', path, response: checked.response };
  }

  /**
   * `TransactionSource` over the same lookup, for use without a composite.
   *
   * Absence becomes `not-found`, which is the honest reading when fixtures are
   * the only source there is: no recording exists, and there is no network to
   * ask. `CompositeSource` never takes this path — it calls `load` precisely so
   * that absence stays distinguishable from unreadability.
   */
  async fetch(signature: Base58Signature): Promise<SourceResult> {
    const lookup = await this.load(signature);
    switch (lookup.kind) {
      case 'loaded':
        return { ok: true, response: lookup.response };
      case 'absent':
        return { ok: false, error: { kind: 'not-found' } };
      case 'unreadable':
        return {
          ok: false,
          error: { kind: 'fixture-unreadable', path: lookup.path, detail: lookup.detail },
        };
    }
  }
}
