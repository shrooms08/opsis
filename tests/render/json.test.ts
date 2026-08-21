/**
 * Unit tests for the canonical JSON serializer. Requirements 13.1–13.8, 9.2.
 *
 * Three kinds of assertion, deliberately kept apart.
 *
 * - **Against the emitted text**, for anything about ordering, omission, or
 *   escaping. A parsed round trip cannot see key order at all and cannot tell an
 *   omitted key from one the parser happened to drop, so `undefined`-omission and
 *   sortedness are checked on the string.
 * - **Against a parse of the text**, for content. The oracle is
 *   `JSON.parse(JSON.stringify(value))`: the runtime's own serializer applies the
 *   same `undefined`-omission and `null`-preservation rules and shares no code
 *   with this module, so agreeing with it is evidence rather than a tautology.
 * - **Through the real pipeline**, over the recorded fixtures, because that is the
 *   shape the renderer actually has to serialize. Nothing is mocked: the same
 *   `analyzeTransaction` the CLI calls produces the `Analysis`.
 *
 * Property 40 (round trip over arbitrary `Analysis` values) is Phase 2 and is not
 * implemented here; the round-trip assertions below are its example-level form.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Analysis, Confidence } from '../../src/model/analysis.js';
import type { RawTransactionResponse } from '../../src/model/rawResponse.js';
import { analyzeTransaction } from '../../src/pipeline.js';
import { canonicalJson, JsonSerializationError, renderJson } from '../../src/render/json.js';
import { asTransactionResponse } from '../../src/source/index.js';
import { goldenCases } from '../source/support/golden.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `renderJson` takes an `Analysis`; these tests feed it shapes on purpose. */
function textOf(value: unknown): string {
  const rendered = renderJson(value as Analysis);
  if (!rendered.ok) throw new Error(`expected a successful render: ${rendered.failure.message}`);
  return rendered.text;
}

const ESC = '\u001b';

/** Every JSON pointer at which the document has a key named `confidence`. */
function confidencePointers(value: unknown, path = ''): readonly string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((element, index) => confidencePointers(element, `${path}/${index}`));
  }
  const record = value as Readonly<Record<string, unknown>>;
  return Object.keys(record).flatMap((key) => {
    const at = `${path}/${key}`;
    return key === 'confidence' ? [at] : confidencePointers(record[key], at);
  });
}

function valueAt(document: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .reduce<unknown>(
      (node, step) => (node as Readonly<Record<string, unknown>>)[step],
      document,
    );
}

/** Every object key in the text, level by level, must be non-descending. */
function keysAreSorted(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(keysAreSorted);
  const keys = Object.keys(value as object);
  const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (keys.join('\u0000') !== sorted.join('\u0000')) return false;
  return Object.values(value as object).every(keysAreSorted);
}

/**
 * Key order as it appears in the text, which is what a parse cannot show. Every
 * `"key":` occurrence in document order; good enough on documents whose string
 * values contain no `":` sequence, which is true of everything constructed here.
 */
function keyOrderInText(text: string): readonly string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((match) => match[1] as string);
}

function responseOf(document: unknown): RawTransactionResponse {
  const checked = asTransactionResponse(document);
  if (!checked.ok) throw new Error(`recorded fixture is not a response: ${checked.detail}`);
  return checked.response;
}

// ---------------------------------------------------------------------------
// A synthetic Analysis covering every confidence-carrying variant
// ---------------------------------------------------------------------------

/**
 * One `Analysis` that exercises every variant carrying a `Confidence` marker:
 * `AccountEntry`, both `AccountRef` variants, all three `InstructionDecode`
 * variants, both `ComputeUnits` variants, `AttributedLog`, `CpiAttribution`,
 * `ResolvedError` resolved and non-custom, both `LamportBalanceChange` variants,
 * `TokenBalanceChange`, and `LogReport`. The `unresolved` `ResolvedError` variant
 * is covered separately below, since one `Analysis` carries only two errors.
 *
 * Typed as `Analysis`, so the compiler is what keeps this in step with the model.
 * The lamport strings are deliberately extreme: `u64::MAX` and a negative delta,
 * both of which a float would destroy.
 */
function sampleAnalysis(): Analysis {
  return {
    signature: 'Sig11111111111111111111111111111111111111111',
    messageVersion: 'v0',
    outcome: {
      succeeded: false,
      error: { kind: 'non-custom', variant: 'InsufficientFundsForRent', detail: null, confidence: 'full' },
    },
    accountKeys: [
      {
        index: 0,
        address: 'Acct1111111111111111111111111111111111111111',
        signer: true,
        role: 'writable',
        origin: { kind: 'static' },
        referencedBy: [0, 1],
        name: null,
        confidence: 'full',
      },
      {
        index: 1,
        address: 'Acct2222222222222222222222222222222222222222',
        signer: false,
        role: 'readonly',
        origin: { kind: 'lookup-table', loadedFrom: 'readonly' },
        referencedBy: [],
        // A name carrying an ANSI sequence and non-ASCII text: Req 13.5 must hold
        // for input strings too, and Req 13.2 for the non-ASCII.
        name: `${ESC}[31mauthority${ESC}[0m — zoë`,
        confidence: 'partial',
      },
    ],
    instructions: [
      {
        order: 0,
        depth: 0,
        parentOrder: null,
        programId: 'Prog1111111111111111111111111111111111111111',
        programName: 'System Program',
        decode: {
          kind: 'full',
          name: 'transfer',
          source: 'builtin',
          fields: [
            { name: 'lamports', value: { type: 'lamports', value: '18446744073709551615' } },
            { name: 'flag', value: { type: 'bool', value: false } },
          ],
          confidence: 'full',
        },
        accounts: [
          {
            kind: 'resolved',
            index: 0,
            address: 'Acct1111111111111111111111111111111111111111',
            signer: true,
            role: 'writable',
            origin: { kind: 'static' },
            name: null,
            confidence: 'full',
          },
          { kind: 'unresolved', index: 9, reason: 'index 9 exceeds the key list', confidence: 'raw' },
        ],
        failed: true,
        valid: true,
        invalidReason: null,
        computeUnits: { available: true, value: 4321, confidence: 'full' },
        logs: [{ index: 0, message: `Program log: ${ESC}[1mhi${ESC}[0m`, confidence: 'partial' }],
        inner: [
          {
            order: 1,
            depth: 1,
            parentOrder: 0,
            programId: null,
            programName: null,
            decode: {
              kind: 'partial',
              name: 'mintTo',
              source: 'anchor-idl',
              decodedFields: [{ name: 'amount', value: { type: 'u64', value: '7' } }],
              undecodedData: { label: 'raw_instruction_data', hex: '0xdeadbeef', byteLength: 4, truncated: false },
              confidence: 'partial',
            },
            accounts: [],
            failed: false,
            valid: true,
            invalidReason: null,
            computeUnits: { available: false, confidence: 'raw' },
            logs: [],
            inner: [],
            confidence: 'partial',
          },
        ],
        confidence: 'partial',
      },
      {
        order: 2,
        depth: 0,
        parentOrder: null,
        programId: 'Prog2222222222222222222222222222222222222222',
        programName: null,
        decode: {
          kind: 'raw',
          name: 'Unknown',
          note: 'Unknown program',
          rawInstructionData: { label: 'raw_instruction_data', hex: '0x00', byteLength: 1, truncated: false },
          errorDetail: null,
          confidence: 'raw',
        },
        accounts: [],
        failed: false,
        valid: false,
        invalidReason: 'program index 7 is out of range',
        computeUnits: { available: false, confidence: 'raw' },
        logs: [],
        inner: [],
        confidence: 'raw',
      },
    ],
    failure: {
      failingInstructionIndex: 0,
      indexOutOfRange: false,
      error: {
        kind: 'resolved',
        code: 6001,
        namespace: 'anchor-user',
        name: 'SlippageExceeded',
        message: null,
        attestation: 'anchor-error-log',
        programId: 'Prog1111111111111111111111111111111111111111',
        confidence: 'full',
      },
      cpiAttribution: {
        instructionOrder: 1,
        programId: 'Prog1111111111111111111111111111111111111111',
        evidence: ['Program Prog1 invoke [2]'],
        confidence: 'partial',
      },
    },
    lamportBalances: [
      {
        kind: 'delta',
        accountIndex: 0,
        address: 'Acct1111111111111111111111111111111111111111',
        pre: '18446744073709551615',
        post: '18446744073709546615',
        delta: '-5000',
        confidence: 'full',
      },
      {
        kind: 'post-only',
        accountIndex: 1,
        address: 'Acct2222222222222222222222222222222222222222',
        post: '0',
        confidence: 'partial',
      },
    ],
    tokenBalances: [
      {
        accountIndex: 1,
        address: 'Acct2222222222222222222222222222222222222222',
        mint: 'Mint1111111111111111111111111111111111111111',
        pre: null,
        post: { mint: 'Mint1111111111111111111111111111111111111111', raw: '1000000', decimals: { known: true, value: 6 } },
        delta: { mint: 'Mint1111111111111111111111111111111111111111', raw: '1000000', decimals: { known: false } },
        lifecycle: 'created',
        confidence: 'partial',
      },
    ],
    compute: { total: { available: true, value: 9999, confidence: 'full' } },
    logs: {
      messages: [`Program log: ${ESC}[32mok${ESC}[0m`, 'Program failed: custom program error: 0x1771'],
      present: true,
      truncated: false,
      unattributed: [],
      confidence: 'full',
    },
  };
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('key ordering', () => {
  it('sorts keys lexicographically at the root', () => {
    const text = textOf({ zeta: 1, alpha: 2, Mid: 3, beta: 4 });

    expect(text).toBe('{"Mid":3,"alpha":2,"beta":4,"zeta":1}');
  });

  it('sorts keys at every nesting level, including inside arrays of objects', () => {
    const text = textOf({
      outer: { z: { y: 1, b: 2 }, a: 3 },
      list: [
        { second: 1, first: 2 },
        { delta: 1, charlie: 2, bravo: 3 },
      ],
    });

    expect(text).toBe(
      '{"list":[{"first":2,"second":1},{"bravo":3,"charlie":2,"delta":1}],"outer":{"a":3,"z":{"b":2,"y":1}}}',
    );
  });

  it('preserves array element order while sorting the keys within each element', () => {
    const text = textOf({ items: [{ b: 1, a: 2 }, 'x', 3, null, { d: 1, c: 2 }] });

    expect(text).toBe('{"items":[{"a":2,"b":1},"x",3,null,{"c":2,"d":1}]}');
  });

  it('orders by code unit rather than by locale', () => {
    // A locale-aware collation groups these as a/ä/b/z; code units put every
    // non-ASCII code point after every ASCII one. Req 9.7.
    const text = textOf({ ä: 1, z: 2, a: 3, B: 4 });

    expect(keyOrderInText(text)).toEqual(['B', 'a', 'z', 'ä']);
  });

  it('sorts keys of the real Analysis at every level', () => {
    const parsed: unknown = JSON.parse(textOf(sampleAnalysis()));

    expect(keysAreSorted(parsed)).toBe(true);
    expect(keyOrderInText(textOf(sampleAnalysis())).length).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// undefined vs null — Requirement 13.7
// ---------------------------------------------------------------------------

describe('absence', () => {
  it('omits keys whose value is undefined and keeps keys whose value is null', () => {
    const text = textOf({ kept: null, dropped: undefined, alsoKept: 0 });

    // Asserted on the text, not on a parse: a parse cannot distinguish an omitted
    // key from one the parser dropped.
    expect(text).toBe('{"alsoKept":0,"kept":null}');
    expect(text).not.toContain('dropped');
  });

  it('omits undefined at every level and still serializes successfully', () => {
    const text = textOf({ a: { gone: undefined, here: null }, b: [{ gone: undefined, here: 1 }] });

    expect(text).toBe('{"a":{"here":null},"b":[{"here":1}]}');
  });

  it('renders undefined inside an array as null rather than renumbering', () => {
    const text = textOf({ items: [1, undefined, 3] });

    expect(text).toBe('{"items":[1,null,3]}');
  });

  it('keeps every null field of the real Analysis', () => {
    const text = textOf(sampleAnalysis());

    expect(text).toContain('"cpiAttribution":{');
    expect(text).toContain('"message":null');
    expect(text).toContain('"pre":null');
    expect(text).toContain('"programName":null');
  });
});

// ---------------------------------------------------------------------------
// Confidence markers — Requirements 13.3, 11.4
// ---------------------------------------------------------------------------

describe('confidence markers', () => {
  it('preserves the marker on every variant that carries one', () => {
    const analysis = sampleAnalysis();
    const parsed: unknown = JSON.parse(textOf(analysis));

    const pointers = confidencePointers(analysis);
    // AccountEntry ×2, AccountRef ×2, InstructionDecode ×3, InstructionNode ×3,
    // ComputeUnits ×4, AttributedLog, CpiAttribution, ResolvedError ×2,
    // LamportBalanceChange ×2, TokenBalanceChange, LogReport.
    expect(pointers.length).toBe(22);
    expect(new Set(pointers.map((pointer) => valueAt(analysis, pointer)))).toEqual(
      new Set<Confidence>(['full', 'partial', 'raw']),
    );

    for (const pointer of pointers) {
      expect(valueAt(parsed, pointer)).toBe(valueAt(analysis, pointer));
    }
  });

  it('preserves the marker on the unresolved error variant', () => {
    const error = {
      kind: 'unresolved',
      code: 6001,
      rawCode: '0x1771',
      reason: 'no-idl',
      programId: null,
      confidence: 'raw',
    };

    expect(textOf(error)).toBe(
      '{"code":6001,"confidence":"raw","kind":"unresolved","programId":null,"rawCode":"0x1771","reason":"no-idl"}',
    );
  });
});

// ---------------------------------------------------------------------------
// No ANSI — Requirement 13.5
// ---------------------------------------------------------------------------

describe('terminal formatting', () => {
  it('contains no ESC byte even when input strings do', () => {
    const analysis = sampleAnalysis();
    // The input really does carry ANSI sequences, so this is not a vacuous check.
    // Asserted on the value: `JSON.stringify` would already have escaped them.
    expect(analysis.accountKeys[1]?.name).toContain(ESC);
    expect(analysis.logs.messages.join('')).toContain(ESC);

    const text = textOf(analysis);

    expect(text).not.toContain(ESC);
    expect(text).toContain('\\u001b[31mauthority');
    // The escaped form still parses back to the original bytes.
    const parsed = JSON.parse(text) as { readonly accountKeys: readonly { readonly name: string | null }[] };
    expect(parsed.accountKeys[1]?.name).toBe(analysis.accountKeys[1]?.name);
  });

  it('escapes every control character below U+0020', () => {
    const text = textOf({ s: `${ESC}\u0000\u0007\n\t` });

    expect([...text].every((character) => character >= ' ' || character === '\u007f')).toBe(true);
    expect(text).toBe('{"s":"\\u001b\\u0000\\u0007\\n\\t"}');
  });
});

// ---------------------------------------------------------------------------
// Round trip and idempotence — Requirements 13.1, 13.4
// ---------------------------------------------------------------------------

describe('round trip', () => {
  it('parses back to a value deep-equal to the input modulo omitted undefined', () => {
    const analysis = sampleAnalysis();

    const parsed: unknown = JSON.parse(textOf(analysis));

    // The oracle shares no code with this module and applies the same
    // undefined/null rules.
    expect(parsed).toStrictEqual(JSON.parse(JSON.stringify(analysis)));
    expect(parsed).toStrictEqual(canonicalJson(analysis));
  });

  it('is idempotent: serialize, parse, re-serialize is byte-identical', () => {
    const first = textOf(sampleAnalysis());

    const second = textOf(JSON.parse(first));

    expect(second).toBe(first);
  });

  it('produces identical text on two renders of equal values', () => {
    expect(textOf(sampleAnalysis())).toBe(textOf(sampleAnalysis()));
  });

  it('does not mutate the value it renders', () => {
    const analysis = sampleAnalysis();
    const before = JSON.stringify(analysis);

    textOf(analysis);

    expect(JSON.stringify(analysis)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Raw lamports — Requirement 13.8
// ---------------------------------------------------------------------------

describe('lamport units', () => {
  it('emits a u64-scale lamport amount as its exact decimal string with no decimal point', () => {
    const text = textOf(sampleAnalysis());

    expect(text).toContain('"pre":"18446744073709551615"');
    expect(text).toContain('"post":"18446744073709546615"');
    expect(text).toContain('"delta":"-5000"');
    // No SOL conversion: not the 9-fractional-digit form of any of the three,
    // and no fractional number anywhere in the document. (The word "sol" itself
    // is not assertable — "unresolved" contains it.)
    expect(text).not.toContain('18446744073.709551615');
    expect(text).not.toContain('18446744073.709546615');
    expect(text).not.toContain('0.000005');
    expect(text).not.toMatch(/\d\.\d/);
  });

  it('leaves every lamport field an integer string', () => {
    const parsed = JSON.parse(textOf(sampleAnalysis())) as {
      readonly lamportBalances: readonly Readonly<Record<string, unknown>>[];
    };

    for (const balance of parsed.lamportBalances) {
      for (const field of ['pre', 'post', 'delta']) {
        const value = balance[field];
        if (value === undefined) continue;
        expect(typeof value).toBe('string');
        expect(value as string).toMatch(/^-?\d+$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The real pipeline over the recorded fixtures
// ---------------------------------------------------------------------------

describe('over the recorded fixtures, through the real pipeline', () => {
  for (const recorded of goldenCases()) {
    it(`renders ${recorded.name} canonically`, () => {
      const analysis = analyzeTransaction({ response: responseOf(recorded.document) });

      const rendered = renderJson(analysis);
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) return;
      const text = rendered.text;

      const parsed: unknown = JSON.parse(text);
      expect(keysAreSorted(parsed)).toBe(true);
      expect(parsed).toStrictEqual(JSON.parse(JSON.stringify(analysis)));
      expect(text).not.toContain(ESC);
      // Idempotent, and identical across renders (Req 9.1).
      expect(textOf(parsed)).toBe(text);
      expect(renderJson(analyzeTransaction({ response: responseOf(recorded.document) }))).toStrictEqual(rendered);

      // Every confidence marker in the Analysis is at the same pointer in the output.
      const pointers = confidencePointers(analysis);
      expect(pointers.length).toBeGreaterThan(0);
      for (const pointer of pointers) {
        expect(valueAt(parsed, pointer)).toBe(valueAt(analysis, pointer));
      }

      // Raw lamports, never SOL (Req 13.8).
      for (const balance of analysis.lamportBalances) {
        expect(balance.post).toMatch(/^-?\d+$/);
        expect(text).toContain(`"post":"${balance.post}"`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The defensive failure guard — Requirement 13.6
// ---------------------------------------------------------------------------

describe('serialization failure', () => {
  const unrepresentable: readonly (readonly [string, unknown, string])[] = [
    ['a bigint', { lamports: 1n }, 'type bigint'],
    ['a NaN', { units: Number.NaN }, 'number NaN'],
    ['an Infinity', { units: Number.POSITIVE_INFINITY }, 'number Infinity'],
    ['a function', { fn: () => 1 }, 'type function'],
    ['a symbol', { s: Symbol('s') }, 'type symbol'],
    ['a Date', { at: new Date(0) }, 'Date is not a plain object'],
    ['a Map', { m: new Map() }, 'Map is not a plain object'],
    ['a bare undefined', undefined, 'type undefined'],
  ];

  for (const [label, value, expected] of unrepresentable) {
    it(`reports ${label} as a serialization failure instead of throwing`, () => {
      const rendered = renderJson(value as Analysis);

      expect(rendered.ok).toBe(false);
      if (rendered.ok) return;
      expect(rendered.failure.kind).toBe('json-serialization-failure');
      expect(rendered.failure.message).toContain('serialization failure');
      expect(rendered.failure.reason).toContain(expected);
    });
  }

  it('locates the offending value with a JSON pointer', () => {
    const rendered = renderJson({ lamportBalances: [{ pre: 1n }] } as unknown as Analysis);

    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.failure.path).toBe('/lamportBalances/0/pre');
    expect(rendered.failure.message).toContain('/lamportBalances/0/pre');
  });

  it('escapes ~ and / in a pointer per RFC 6901', () => {
    const rendered = renderJson({ 'a/b~c': Number.NaN } as unknown as Analysis);

    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.failure.path).toBe('/a~1b~0c');
  });

  it('names a reference cycle instead of exhausting the stack', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;

    const rendered = renderJson(cyclic as unknown as Analysis);

    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.failure.reason).toContain('reference cycle');
    expect(rendered.failure.path).toBe('/self');
  });

  it('allows the same object to appear twice without being a cycle', () => {
    const shared = { confidence: 'full' };

    expect(textOf({ a: shared, b: shared })).toBe('{"a":{"confidence":"full"},"b":{"confidence":"full"}}');
  });

  it('writes nothing to stderr: the diagnostic is a value the CLI reports', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      renderJson({ lamports: 1n } as unknown as Analysis);
      renderJson(sampleAnalysis());

      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it('throws a typed error from the value form, which the golden harness catches', () => {
    expect(() => canonicalJson({ lamports: 1n })).toThrow(JsonSerializationError);
    try {
      canonicalJson({ lamports: 1n });
      expect.unreachable('canonicalJson should have thrown');
    } catch (cause) {
      expect(cause).toBeInstanceOf(JsonSerializationError);
      expect((cause as JsonSerializationError).failure.path).toBe('/lamports');
    }
  });

  it('reports a failure at the document root without a pointer', () => {
    const rendered = renderJson(Number.NaN as unknown as Analysis);

    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.failure.path).toBe('');
    expect(rendered.failure.message).toContain('the document root');
  });
});

// ---------------------------------------------------------------------------
// The value form the golden harness consumes
// ---------------------------------------------------------------------------

describe('canonicalJson as the harness drop-in', () => {
  it('matches the value form the harness compares against', () => {
    const value = { z: 1, a: { gone: undefined, kept: null }, list: [{ b: 1, a: 2 }, undefined] };

    expect(canonicalJson(value)).toStrictEqual({ a: { kept: null }, list: [{ a: 2, b: 1 }, null], z: 1 });
  });

  it('passes primitives and null through unchanged', () => {
    expect(canonicalJson(null)).toBe(null);
    expect(canonicalJson('x')).toBe('x');
    expect(canonicalJson(0)).toBe(0);
    expect(canonicalJson(-1)).toBe(-1);
    expect(canonicalJson(true)).toBe(true);
    expect(canonicalJson([])).toStrictEqual([]);
    expect(canonicalJson(Object.create(null) as object)).toStrictEqual({});
  });

  it('agrees with the emitted text on the real Analysis', () => {
    const analysis = sampleAnalysis();

    expect(JSON.parse(textOf(analysis))).toStrictEqual(canonicalJson(analysis));
  });

  it('agrees with itself across calls on the synthetic and the recorded shapes', () => {
    // This assertion was the equivalence check between this function and the
    // golden harness's local `canonicalize` stand-in, over every value the
    // harness feeds it. The harness now calls `canonicalJson` directly and the
    // stand-in is deleted, so what is left is the determinism half of the same
    // claim (Req 9.1): equal inputs, deep-equal canonical values, call after call.
    expect(canonicalJson(sampleAnalysis())).toStrictEqual(canonicalJson(sampleAnalysis()));

    for (const recorded of goldenCases()) {
      const analysis = analyzeTransaction({ response: responseOf(recorded.document) });
      expect(canonicalJson(analysis)).toStrictEqual(canonicalJson(analysis));
    }
  });
});
