/**
 * The canonical JSON serializer — JSON_Renderer.
 *
 * Satisfies Requirement 13 (13.1–13.8) and Requirement 9.2.
 *
 * Keys are sorted lexicographically at every level, keys whose value is
 * `undefined` are omitted, keys whose value is `null` are preserved, the text is
 * RFC 8259 conformant, carries no ANSI escape sequence, and is written as UTF-8
 * by whoever holds the stream (Req 13.1, 13.2, 13.5, 13.7, 9.2). Balances stay in
 * raw lamport units: no SOL conversion, no rounding, no reformatting happens here
 * or anywhere else on this path (Req 13.8). SOL is a `render/text.ts` concern and
 * the word does not appear in JSON output.
 *
 * Serialization over an `Analysis` is **total**. The data model admits only
 * strings, safe integers, booleans, `null`, arrays, and plain objects, so there
 * is no inhabitant of the type that JSON cannot represent, and the walk below is
 * a structural pass-through that renames nothing and drops nothing — every field,
 * including every `Confidence` marker, survives by construction (Req 13.3). The
 * failure path (Req 13.6) is therefore a defensive guard rather than an expected
 * outcome: it is reachable only from a value that has escaped the type, which is
 * exactly when a silent `null` in the output would be at its most misleading.
 *
 * ## Two deviations, both recorded here rather than left as surprises
 *
 * **1. `renderJson` returns a result, not a `string`.** design.md types it
 * `(analysis: Analysis) => string`, which leaves the Req 13.6 message with
 * nowhere to go but a stream. This module writes to no stream. design.md declares
 * `cli.ts` the owner of the only `process.stderr` reference in the codebase and
 * `writeDiagnostic` in `exit.ts` the only sanctioned path for a diagnostic, so a
 * stream reference here would be a second one, in a renderer, and would make this
 * module untestable without capturing output. `decode/idl/idlStore.ts` resolves
 * the same tension the same way: the diagnostic is returned as a value and
 * `cli.ts` writes it. Requirement 13.6 is still satisfied — the message still
 * names the failure and still reaches stderr — one module later, where task 11.4
 * also assigns it exit code 2.
 *
 * **2. `canonicalJson` throws where `renderJson` returns.** The value form is
 * what the golden harness compares against, and a harness that had to unwrap a
 * result at the one place it wants a value would be worse off; a throw there is
 * caught by the harness and reported as that fixture's failure. `renderJson`,
 * which the CLI calls, never throws.
 *
 * ## `JSON.stringify` for escaping, a hand-rolled walk for structure
 *
 * A `JSON.stringify` replacer cannot sort keys — the replacer sees a key after
 * the traversal order is fixed — so key ordering needs its own pass either way.
 * Given that pass, the value form the harness needs falls out of it for free, and
 * the walk is also where a non-representable value can be *named* with a JSON
 * pointer instead of silently becoming `null` (`NaN`) or vanishing (`undefined`).
 *
 * What is *not* hand-rolled is string escaping. `JSON.stringify` on a single
 * string is the RFC 8259 escaper already in the runtime: it escapes every control
 * character below U+0020 — including ESC (U+001B) as `\u001b`, which is what makes
 * Req 13.5 hold even for an input string that itself contains an ANSI sequence —
 * and it emits lone surrogates as escapes, so the result is always encodable as
 * UTF-8. Re-implementing that would be the one part of this module with real
 * defect surface.
 */

import type { Analysis } from '../model/analysis.js';

// ---------------------------------------------------------------------------
// The canonical value form
// ---------------------------------------------------------------------------

/** Anything RFC 8259 can represent. The image of `canonicalJson`. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * What made a value unrepresentable, and where it was.
 *
 * `message` is ready to hand to `writeDiagnostic` unchanged; it names the failure
 * as a serialization failure (Req 13.6) and locates it, because "cannot
 * serialize" without a path is the least actionable diagnostic there is.
 */
export interface JsonSerializationFailure {
  readonly kind: 'json-serialization-failure';
  /** RFC 6901 JSON pointer to the offending value. `''` is the document root. */
  readonly path: string;
  readonly reason: string;
  /** Ready to print. */
  readonly message: string;
}

/** The throwing form of {@link JsonSerializationFailure}, for `canonicalJson`. */
export class JsonSerializationError extends Error {
  readonly failure: JsonSerializationFailure;

  constructor(failure: JsonSerializationFailure) {
    super(failure.message);
    this.name = 'JsonSerializationError';
    this.failure = failure;
  }
}

/**
 * Sorted keys at every level, `undefined` values omitted, `null` preserved.
 *
 * The canonical *value*. `renderJson` is this followed by `emit`, and the golden
 * harness compares against this directly, so the shape a fixture pins and the
 * shape the CLI prints cannot drift apart.
 *
 * `undefined` omission is the part that carries weight: `exactOptionalPropertyTypes`
 * lets an absent optional field be spelled either `{}` or `{ k: undefined }` in
 * TypeScript, while JSON has one spelling for absence and a different value,
 * `null`, for "we looked and it is not there". `Analysis` uses both meanings, so
 * collapsing them would let a dropped field read as a null one.
 *
 * Throws {@link JsonSerializationError} on a value outside `JsonValue`.
 */
export function canonicalJson(value: unknown): JsonValue {
  return canonicalize(value, '', new Set<object>());
}

/**
 * Code-unit comparison, never `localeCompare`: collation is locale-dependent and
 * would make key order — and therefore the output bytes — shift with `LANG`,
 * which Requirement 9.7 forbids. Matches `decode/idl/idlStore.ts`.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** RFC 6901: `~` is `~0` and `/` is `~1`, in that order. */
function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function failureAt(path: string, reason: string): JsonSerializationError {
  const where = path === '' ? 'the document root' : path;
  return new JsonSerializationError({
    kind: 'json-serialization-failure',
    path,
    reason,
    message: `serialization failure: ${reason} at ${where}`,
  });
}

/**
 * `ancestors` holds the objects on the current path, so a reference cycle is
 * named rather than exhausting the stack. `Analysis` is a finite acyclic tree, so
 * this only ever fires on a value that escaped the type.
 */
function canonicalize(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null) return null;

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'number':
      // `JSON.stringify` turns NaN and ±Infinity into `null`, which would put a
      // fabricated value in the output under a field that had a real one.
      if (!Number.isFinite(value)) {
        throw failureAt(path, `the number ${String(value)} has no JSON representation`);
      }
      return value;
    case 'object':
      break;
    default:
      // `undefined`, `bigint`, `symbol`, `function`. `undefined` reaches here only
      // at the root or as an array element already handled below, since an object
      // key holding it is dropped rather than visited.
      throw failureAt(path, `a value of type ${typeof value} has no JSON representation`);
  }

  const object = value as object;
  if (ancestors.has(object)) {
    throw failureAt(path, 'the value is part of a reference cycle');
  }
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      // `undefined` in an array becomes `null`, as `JSON.stringify` does: an array
      // cannot omit an element without renumbering every element after it, and
      // renumbering would change what the indices mean.
      return (object as readonly unknown[]).map((element, index) =>
        element === undefined ? null : canonicalize(element, `${path}/${index}`, ancestors),
      );
    }

    const prototype: unknown = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      // A `Date`, `Map`, or class instance has no own enumerable data to speak of,
      // so treating it as a plain object would emit `{}` and lose the value in
      // silence. `Analysis` holds none of them.
      throw failureAt(path, `a ${constructorNameOf(object)} is not a plain object and has no JSON representation`);
    }

    const source = object as Readonly<Record<string, unknown>>;
    const canonical: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort(byCodeUnit)) {
      const entry = source[key];
      if (entry === undefined) continue;
      canonical[key] = canonicalize(entry, `${path}/${escapePointer(key)}`, ancestors);
    }
    return canonical;
  } finally {
    ancestors.delete(object);
  }
}

function constructorNameOf(object: object): string {
  const name: unknown = (object as { readonly constructor?: { readonly name?: unknown } }).constructor?.name;
  return typeof name === 'string' && name !== '' ? name : 'non-plain object';
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * A `JsonValue` as RFC 8259 text: no whitespace, no trailing newline, keys in
 * code-unit order.
 *
 * Keys are re-sorted here rather than trusted from insertion order. JavaScript
 * enumerates integer-like own keys (`"0"`, `"7"`) ascending numerically before
 * every other key, whatever order they were inserted in, so insertion order alone
 * would not guarantee a lexicographic emission. `Analysis` has no such key, and
 * sorting here means it would not matter if one appeared.
 */
function emit(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    // Leaves: the runtime's own RFC 8259 escaper. See the header.
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((element) => emit(element)).join(',')}]`;
  }

  const record = value as { readonly [key: string]: JsonValue };
  const members = Object.keys(record)
    .sort(byCodeUnit)
    .map((key) => `${JSON.stringify(key)}:${emit(record[key] as JsonValue)}`);
  return `{${members.join(',')}}`;
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

export type JsonRender =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly failure: JsonSerializationFailure };

/**
 * The `Analysis` as canonical JSON text, or the diagnostic the CLI prints.
 *
 * Total: this never throws. An unexpected throw from the walk is reported as a
 * serialization failure rather than propagated, because the CLI's response to
 * either is the same — the Req 13.6 message on stderr and exit 2 — and a renderer
 * that can throw would need that handling duplicated at the call site.
 */
export function renderJson(analysis: Analysis): JsonRender {
  try {
    return { ok: true, text: emit(canonicalJson(analysis)) };
  } catch (cause) {
    if (cause instanceof JsonSerializationError) {
      return { ok: false, failure: cause.failure };
    }
    /* c8 ignore start -- the walk throws nothing else; this covers a stack
       exhaustion on a pathologically deep value. */
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      failure: {
        kind: 'json-serialization-failure',
        path: '',
        reason,
        message: `serialization failure: ${reason}`,
      },
    };
    /* c8 ignore stop */
  }
}
