/**
 * Layout, color placement, and marker exclusivity for the terminal renderer —
 * Requirements 12.1, 12.3, 12.4, 12.6.
 *
 * The companion to `text.test.ts`, which already pins section presence and order,
 * two-space-per-level indentation, `[FAIL]` on exactly the failing instruction,
 * `[ERROR]` on a resolved error, uppercase role labels on the sample, the absence
 * of an ESC byte with color off, pairwise distinctness of the four category
 * colors, and the whole `decideColorMode` table. Nothing here restates any of
 * that. What is here is the four claims that file leaves open.
 *
 * **1. The third text marker of Requirement 12.6, read exhaustively.** 12.6 names
 * three and only three: the `[FAIL]` prefix, the `[ERROR]` prefix, and uppercase
 * labels for account roles. The third is therefore the role label, and it is
 * pinned here over every role position the model can produce rather than over the
 * two spellings one sample happens to contain. The `[full]`/`[partial]`/`[raw]`
 * confidence markers look like a fourth marker and are not one: they are emitted
 * identically in both modes, so they substitute for no color and 12.6 does not
 * name them. That reading is asserted below rather than left as a comment.
 *
 * **2. Layout as a contract a reader can rely on.** A heading is unambiguous
 * because every other line in its section is indented. A value can be found
 * because the label column is a single column. There is no trailing whitespace, no
 * blank line inside a section, and no trailing newline — the last of which is
 * `cli.ts`'s `withNewline` to add, so it is checked at that boundary and not just
 * on the renderer's return value.
 *
 * **3. Color placement, not just distinctness.** Distinctness says the four
 * colors differ. It says nothing about where they stop. Every opening SGR
 * sequence is matched by a reset before the next one opens and before the line
 * ends, so no color bleeds past its token. Then the statement that the two modes
 * carry the same information: **stripping the ANSI from the color-on output and
 * applying exactly the Requirement 12.6 substitutions yields the color-off output
 * byte for byte.** A property cannot state that, because the substitution is
 * defined by which color wrapped which span — which only the color-on output
 * knows.
 *
 * **4. Marker exclusivity, in both directions.** With color on the three text
 * markers must be absent, because they are the substitute and not an addition.
 * With color off no ESC byte may appear.
 *
 * Everything runs over the six recorded fixtures through the real pipeline as
 * well as over a synthetic `Analysis`. Real data is where 44-character addresses,
 * deep trees, and long IDL-derived names put pressure on a column; the synthetic
 * one reaches the role and variant combinations no recorded fixture contains.
 *
 * The renderer escapes C0 and DEL in chain-derived data as `\xNN` **text, in both
 * modes**, so an escaped sequence is identical in the two outputs and the
 * equivalence in claim 3 is unaffected by it. The ANSI stripping below matches a
 * real ESC byte only, never the six literal characters `\`, `x`, `1`, `b`, `[`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main, type MainContext } from '../../src/cli.js';
import type { Analysis, TokenAmount } from '../../src/model/analysis.js';
import type { RawTransactionResponse } from '../../src/model/rawResponse.js';
import { analyzeTransaction } from '../../src/pipeline.js';
import {
  COLOR_CATEGORIES,
  createPalette,
  ERROR_MARKER,
  FAIL_MARKER,
  SECTION_TITLES,
  renderText,
  type ColorCategory,
  type ColorMode,
} from '../../src/render/text.js';
import { asTransactionResponse } from '../../src/source/index.js';
import { goldenCases } from '../source/support/golden.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESC = '\u001b';

function textOf(analysis: Analysis, mode: ColorMode): string {
  const rendered = renderText(analysis, mode);
  if (!rendered.ok) throw new Error(`expected a successful render: ${rendered.failure.message}`);
  return rendered.text;
}

function analysisOf(document: unknown): Analysis {
  const checked = asTransactionResponse(document);
  if (!checked.ok) throw new Error(`recorded fixture is not a response: ${checked.detail}`);
  const response: RawTransactionResponse = checked.response;
  return analyzeTransaction({ response });
}

/** SGR sequences removed. A real ESC byte only, never the `\x1b` escaped text. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Every section, heading included, split at the Requirement 12.1 blank line. */
function sectionsOf(text: string): readonly string[] {
  return text.split('\n\n');
}

/** Regex-literal form of an arbitrary string. */
function quoteRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The opening and closing sequences one category wraps a span in, read off the
 * palette rather than written down.
 *
 * A probe that cannot occur in a color code, painted, then split on itself: what
 * precedes it is the open and what follows is the close. This is how the tests
 * below can name `picocolors`' exact bytes without hard-coding `31m`, so a
 * palette change breaks the renderer's own distinctness test and not the parsing
 * here.
 */
interface Wrap {
  readonly open: string;
  readonly close: string;
}

const PROBE = '\u0001probe\u0001';

function wrapOf(category: ColorCategory): Wrap {
  const painted = createPalette('on')[category](PROBE);
  const parts = painted.split(PROBE);
  expect(parts).toHaveLength(2);
  return { open: parts[0] ?? '', close: parts[1] ?? '' };
}

const WRAPS: ReadonlyMap<ColorCategory, Wrap> = new Map(
  COLOR_CATEGORIES.map((category) => [category, wrapOf(category)] as const),
);

// ---------------------------------------------------------------------------
// The corpus: six recorded fixtures through the real pipeline, plus a synthetic
// ---------------------------------------------------------------------------

/**
 * An `Analysis` reaching every role position, an `UNRESOLVED` ref, three tree
 * levels, a failing instruction, a resolved error, and a token amount with
 * unknown decimals.
 *
 * Distinct from `text.test.ts`'s sample and kept here so that file stays
 * untouched. The emphasis is different too: this one exists to put every one of
 * the five role-label spellings and every colored category on screen at once,
 * which is what the exclusivity and equivalence claims need.
 */
function layoutAnalysis(): Analysis {
  const mint = 'Mint1111111111111111111111111111111111111111';
  const scaled: TokenAmount = { mint, raw: '250000', decimals: { known: true, value: 6 } };
  const unscaled: TokenAmount = { mint, raw: '250000', decimals: { known: false } };
  const program = 'Prog1111111111111111111111111111111111111111';

  return {
    signature: 'Sig11111111111111111111111111111111111111111',
    messageVersion: 'v0',
    outcome: {
      succeeded: false,
      error: {
        kind: 'resolved',
        code: 6001,
        namespace: 'anchor-user',
        name: 'SlippageExceeded',
        message: 'the price moved',
        attestation: 'anchor-error-log',
        programId: program,
        confidence: 'full',
      },
    },
    accountKeys: [
      {
        index: 0,
        address: 'Acct1111111111111111111111111111111111111111',
        signer: true,
        role: 'writable',
        origin: { kind: 'static' },
        referencedBy: [0],
        name: 'authority',
        confidence: 'full',
      },
      {
        index: 1,
        address: 'Acct2222222222222222222222222222222222222222',
        signer: false,
        role: 'writable',
        origin: { kind: 'static' },
        referencedBy: [0, 1],
        name: null,
        confidence: 'full',
      },
      {
        index: 2,
        address: 'Acct3333333333333333333333333333333333333333',
        signer: true,
        role: 'readonly',
        origin: { kind: 'static' },
        referencedBy: [],
        name: null,
        confidence: 'partial',
      },
      {
        index: 3,
        address: 'Acct4444444444444444444444444444444444444444',
        signer: false,
        role: 'readonly',
        origin: { kind: 'lookup-table', loadedFrom: 'readonly' },
        referencedBy: [1],
        // A forged sequence in chain-derived data, escaped as text in both modes.
        name: `${ESC}[31mspoofed${ESC}[0m`,
        confidence: 'partial',
      },
    ],
    instructions: [
      {
        order: 0,
        depth: 0,
        parentOrder: null,
        programId: program,
        programName: 'Some Program',
        decode: {
          kind: 'full',
          name: 'swap',
          source: 'anchor-idl',
          fields: [
            { name: 'amountIn', value: { type: 'u64', value: '250000' } },
            { name: 'flag', value: { type: 'bool', value: false } },
            { name: 'memo', value: { type: 'string', value: 'hi' } },
            { name: 'holder', value: { type: 'tokenAmount', value: scaled } },
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
            name: 'authority',
            confidence: 'full',
          },
          {
            kind: 'resolved',
            index: 1,
            address: 'Acct2222222222222222222222222222222222222222',
            signer: false,
            role: 'writable',
            origin: { kind: 'static' },
            name: null,
            confidence: 'full',
          },
          {
            kind: 'resolved',
            index: 2,
            address: 'Acct3333333333333333333333333333333333333333',
            signer: true,
            role: 'readonly',
            origin: { kind: 'static' },
            name: null,
            confidence: 'partial',
          },
          {
            kind: 'resolved',
            index: 3,
            address: 'Acct4444444444444444444444444444444444444444',
            signer: false,
            role: 'readonly',
            origin: { kind: 'lookup-table', loadedFrom: 'readonly' },
            name: null,
            confidence: 'partial',
          },
          {
            kind: 'unresolved',
            index: 9,
            reason: 'index 9 exceeds the key list',
            confidence: 'raw',
          },
        ],
        failed: true,
        valid: true,
        invalidReason: null,
        computeUnits: { available: true, value: 42000, confidence: 'full' },
        logs: [],
        inner: [
          {
            order: 1,
            depth: 1,
            parentOrder: 0,
            programId: 'Prog2222222222222222222222222222222222222222',
            programName: null,
            decode: {
              kind: 'partial',
              name: 'mintTo',
              source: 'anchor-idl',
              decodedFields: [{ name: 'amount', value: { type: 'tokenAmount', value: unscaled } }],
              undecodedData: {
                label: 'raw_instruction_data',
                hex: '0xdeadbeef',
                byteLength: 4,
                truncated: false,
              },
              confidence: 'partial',
            },
            accounts: [],
            failed: false,
            valid: true,
            invalidReason: null,
            computeUnits: { available: false, confidence: 'raw' },
            logs: [],
            inner: [
              {
                order: 2,
                depth: 2,
                parentOrder: 1,
                programId: null,
                programName: null,
                decode: {
                  kind: 'raw',
                  name: 'Unknown',
                  note: 'Unknown program',
                  rawInstructionData: {
                    label: 'raw_instruction_data',
                    hex: '0x00',
                    byteLength: 1,
                    truncated: false,
                  },
                  errorDetail: 'no decoder is registered',
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
            confidence: 'raw',
          },
        ],
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
        message: 'the price moved',
        attestation: 'anchor-error-log',
        programId: program,
        confidence: 'full',
      },
      cpiAttribution: {
        instructionOrder: 1,
        programId: 'Prog2222222222222222222222222222222222222222',
        evidence: ['Program Prog2222222222222222222222222222222222222222 failed'],
        confidence: 'partial',
      },
    },
    lamportBalances: [
      {
        kind: 'delta',
        accountIndex: 0,
        address: 'Acct1111111111111111111111111111111111111111',
        pre: '2000000000',
        post: '1995000000',
        delta: '-5000000',
        confidence: 'full',
      },
      {
        kind: 'post-only',
        accountIndex: 3,
        address: 'Acct4444444444444444444444444444444444444444',
        post: '1',
        confidence: 'partial',
      },
    ],
    tokenBalances: [
      {
        accountIndex: 1,
        address: 'Acct2222222222222222222222222222222222222222',
        mint,
        pre: null,
        post: scaled,
        delta: unscaled,
        lifecycle: 'created',
        confidence: 'partial',
      },
    ],
    compute: { total: { available: true, value: 42000, confidence: 'full' } },
    logs: {
      messages: ['Program log: instruction: Swap'],
      present: true,
      truncated: false,
      unattributed: [],
      confidence: 'full',
    },
  };
}

interface Case {
  readonly name: string;
  readonly analysis: Analysis;
}

/** The synthetic case first, then the six recorded ones, by name. */
function cases(): readonly Case[] {
  return [
    { name: 'synthetic', analysis: layoutAnalysis() },
    ...goldenCases().map((recorded) => ({
      name: recorded.name,
      analysis: analysisOf(recorded.document),
    })),
  ];
}

const CASES = cases();

// ---------------------------------------------------------------------------
// The third text marker — Requirement 12.6
// ---------------------------------------------------------------------------

/**
 * Requirement 12.6 names exactly three: `[FAIL]`, `[ERROR]`, and uppercase
 * account role labels. `text.test.ts` pins the first two. The third is the role
 * label, and these are the assertions that make it a contract rather than two
 * `toContain` calls against one sample.
 */
describe('the third text marker: uppercase account role labels', () => {
  /** Every spelling the model can produce: two roles, signer or not, plus the ref. */
  const ROLE_LABELS: readonly string[] = [
    'WRITABLE SIGNER',
    'WRITABLE',
    'READONLY SIGNER',
    'READONLY',
    'UNRESOLVED',
  ];

  it('emits every role spelling in uppercase with color off', () => {
    const text = textOf(layoutAnalysis(), 'off');

    for (const label of ROLE_LABELS) {
      expect(text).toContain(label);
    }
    // And never the lowercase spelling, which belongs to the color-on mode. The
    // two-space suffix anchors on a role position: `readonly` also occurs inside
    // `lookup table (readonly)`, which is an origin and not a role label.
    for (const label of ROLE_LABELS) {
      expect(text).not.toContain(`${label.toLowerCase()}  `);
    }
  });

  it('paints the role instead of uppercasing it with color on', () => {
    const on = textOf(layoutAnalysis(), 'on');
    const palette = createPalette('on');

    for (const label of ROLE_LABELS) {
      // The painted span carries the lowercase text, which is the whole point:
      // uppercase is what stands in for the color, so it is absent here.
      expect(on).toContain(palette.accountRole(label.toLowerCase()));
      expect(on).not.toContain(label);
    }
  });

  for (const { name, analysis } of CASES) {
    it(`uppercases every role position and no other token in ${name}`, () => {
      const on = textOf(analysis, 'on');
      const off = textOf(analysis, 'off');
      const wrap = WRAPS.get('accountRole');
      expect(wrap).toBeDefined();
      if (wrap === undefined) return;

      // The color-on output names its own role spans, so the count is read off
      // the renderer rather than guessed from a line shape.
      const painted = [
        ...on.matchAll(new RegExp(`${quoteRegex(wrap.open)}(.*?)${quoteRegex(wrap.close)}`, 'g')),
      ].map((match) => match[1] ?? '');
      expect(painted.length).toBeGreaterThan(0);

      for (const span of painted) {
        expect(span).toBe(span.toLowerCase());
        expect(off).toContain(span.toUpperCase());
      }
    });
  }

  /**
   * The reading, asserted: a confidence marker is not one of the three.
   *
   * `[full]`, `[partial]`, and `[raw]` are bracketed and uppercase-adjacent and
   * so look like more of the same, but Requirement 12.6 does not name them and
   * they substitute for no color — the renderer emits them identically whether
   * color is on or off. If a future change made one of them color-dependent, this
   * is where that shows up.
   */
  for (const { name, analysis } of CASES) {
    it(`emits identical confidence markers in both modes for ${name}`, () => {
      const markersOf = (text: string): readonly string[] =>
        [...text.matchAll(/\[(?:full|partial|raw)\]/g)].map((match) => match[0]);

      const off = markersOf(textOf(analysis, 'off'));
      const on = markersOf(stripAnsi(textOf(analysis, 'on')));

      expect(off.length).toBeGreaterThan(0);
      expect(on).toEqual(off);
    });
  }
});

// ---------------------------------------------------------------------------
// Section layout as a stable contract — Requirement 12.1
// ---------------------------------------------------------------------------

describe('section layout', () => {
  for (const { name, analysis } of CASES) {
    describe(name, () => {
      for (const mode of ['off', 'on'] as const) {
        it(`indents every non-heading line, so a heading is unambiguous (color ${mode})`, () => {
          const text = textOf(analysis, mode);
          const headings: readonly string[] = Object.values(SECTION_TITLES);

          for (const section of sectionsOf(text)) {
            const lines = section.split('\n');
            const heading = lines[0];
            expect(heading).toBeDefined();
            expect(headings).toContain(heading);
            for (const line of lines.slice(1)) {
              // Column 0 is reserved for headings and for nothing else.
              expect(stripAnsi(line).startsWith(' ')).toBe(true);
            }
          }
        });

        it(`leaves no trailing whitespace on any line (color ${mode})`, () => {
          const text = textOf(analysis, mode);

          const offenders = text
            .split('\n')
            .map((line, index) => [index, line] as const)
            .filter(([, line]) => /[ \t]$/.test(stripAnsi(line)));

          expect(offenders).toEqual([]);
        });

        it(`leaves no blank line inside a section (color ${mode})`, () => {
          const text = textOf(analysis, mode);

          for (const section of sectionsOf(text)) {
            for (const line of section.split('\n')) {
              expect(line).not.toBe('');
            }
          }
          // Which makes the Requirement 12.1 separator exactly two occurrences.
          expect(text.split('\n\n')).toHaveLength(3);
          expect(text).not.toContain('\n\n\n');
        });

        it(`starts every labelled value at the one label column (color ${mode})`, () => {
          const width = labelWidth();
          const labelled = labelledLines(textOf(analysis, mode), width);
          expect(labelled.length).toBeGreaterThan(0);

          for (const { region, value } of labelled) {
            // The value begins at the column and not one character later, so a
            // reader scans one column down the page whatever the indent level.
            expect(value.startsWith(' ')).toBe(false);
            // And not one character earlier: a value that began inside the label
            // region would leave its own two-space gap in there.
            expect(region.trimEnd()).not.toMatch(/ {2}/);
            expect(region.trimEnd()).not.toBe('');
          }
        });

        it(`keeps at least one space between a label and its value (color ${mode})`, () => {
          const width = labelWidth();
          const labelled = labelledLines(textOf(analysis, mode), width);

          for (const { region } of labelled) {
            // True for every label the corpus produces, the longest of which is
            // `raw_instruction_data` at one below the column width. It stops being
            // true at exactly the column width — see the `fails` case below.
            expect(region.endsWith(' ')).toBe(true);
          }
        });
      }
    });
  }

  /** A `<label padded to the column><value>` line, split at the column. */
  interface Labelled {
    /** The first `width` characters after the indent: the label and its padding. */
    readonly region: string;
    /** Everything after the column. */
    readonly value: string;
  }

  /**
   * Every labelled line, split at the label column.
   *
   * A labelled line is one that begins, after its indent, with an
   * identifier-like label. That excludes instruction headers and account rows,
   * which begin with `#` or `[FAIL]` and separate their tokens by a two-space gap
   * rather than by a column, and it excludes `<not in the account key list>`. The
   * bare `accounts` line and the three section headings are label-only and shorter
   * than the column, so the length test drops them: they have no value to align.
   */
  function labelledLines(text: string, width: number): readonly Labelled[] {
    return text
      .split('\n')
      .map((line) => stripAnsi(line))
      .map((line) => line.slice(line.length - line.trimStart().length))
      .filter((rest) => /^[A-Za-z_]/.test(rest) && rest.length > width)
      .map((rest) => ({ region: rest.slice(0, width), value: rest.slice(width) }));
  }

  /**
   * A real defect, recorded rather than fixed.
   *
   * `field()` pads with `padEnd(LABEL_WIDTH)`, which adds nothing once the label
   * has reached that width — so a label of exactly the column width, or longer, is
   * pasted straight onto its value: `maximumAmountInWith5000`, with no way to tell
   * where the name ends and the number begins. The labels the renderer itself uses
   * are all shorter, but a decoded field name is chain-and-IDL-derived and
   * unbounded, and `raw_instruction_data` already sits one character below the
   * limit. Two plausible IDL argument names reach it.
   *
   * Marked `fails` because task 11.7 does not touch `src/`: the finding is the
   * deliverable. The width is measured from the renderer's own output, so this
   * keeps testing the boundary if the column moves.
   */
  it.fails('separates a label at or beyond the column width from its value', () => {
    const width = labelWidth();

    for (const length of [width, width + 8]) {
      const name = 'a'.repeat(length);
      const line = textOf(withFieldNamed(name), 'off')
        .split('\n')
        .find((entry) => entry.includes(name));

      expect(line).toBeDefined();
      // What it produces today is `aaa…aaa7`, the label and the value fused.
      expect(line).not.toContain(`${name}7`);
    }
  });

  /** The synthetic analysis with one decoded field of a chosen name and value `7`. */
  function withFieldNamed(name: string): Analysis {
    const analysis = layoutAnalysis();
    const top = analysis.instructions[0];
    if (top === undefined || top.decode.kind !== 'full') {
      throw new Error('the synthetic analysis no longer opens with a full decode');
    }
    return {
      ...analysis,
      instructions: [
        {
          ...top,
          decode: { ...top.decode, fields: [{ name, value: { type: 'u8', value: 7 } }] },
          inner: [],
        },
      ],
    };
  }

  /**
   * The label column, measured from a line the renderer is known to emit.
   *
   * `version` is a short label with a short value, so the run of spaces between
   * them is unambiguous and its end is the column.
   */
  function labelWidth(): number {
    const line = textOf(layoutAnalysis(), 'off')
      .split('\n')
      .find((entry) => /^ {2}version {2,}\S/.test(entry));
    expect(line).toBeDefined();
    const match = /^ {2}(version {2,})\S/.exec(line ?? '');
    expect(match).not.toBeNull();
    return (match?.[1] ?? '').length;
  }
});

// ---------------------------------------------------------------------------
// The trailing newline, at the boundary that owns it
// ---------------------------------------------------------------------------

/**
 * The renderer returns no trailing newline and `cli.ts` adds exactly one.
 *
 * Both halves in one place, because either alone is satisfiable by a bug: a
 * renderer that appended one and a `withNewline` that appended none would also
 * put a single newline on stdout, and then `render/json.ts` — which relies on the
 * same division — would emit two.
 */
describe('the trailing newline is the CLI\u2019s to add', () => {
  let workspace = '';
  const recorded = goldenCases()[0];

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'opsis-layout-'));
    await mkdir(join(workspace, 'fixtures'));
    expect(recorded).toBeDefined();
    if (recorded === undefined) return;
    await writeFile(join(workspace, 'fixtures', `${recorded.signature}.json`), recorded.text);
  });

  afterAll(async () => {
    if (workspace !== '') await rm(workspace, { recursive: true, force: true });
  });

  for (const { name, analysis } of CASES) {
    it(`renders ${name} with no trailing newline in either mode`, () => {
      for (const mode of ['off', 'on'] as const) {
        const text = textOf(analysis, mode);
        expect(text.endsWith('\n')).toBe(false);
        expect(text.startsWith('\n')).toBe(false);
      }
    });
  }

  it('puts the renderer\u2019s text on stdout followed by exactly one newline', async () => {
    expect(recorded).toBeDefined();
    if (recorded === undefined) return;

    const chunks: string[] = [];
    const context: MainContext = {
      stdout: { write: (chunk: string) => chunks.push(chunk) },
      stderr: { write: () => true },
      env: {},
      isTty: false,
      cwd: workspace,
    };

    await main([recorded.signature], context);
    const stdout = chunks.join('');

    // `withNewline` in `cli.ts` is the only thing between the two, so this is an
    // equality and not a `toContain`.
    const expected = textOf(analysisOf(recorded.document), 'off');
    expect(stdout).toBe(`${expected}\n`);
    expect(stdout.endsWith('\n\n')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Color placement — Requirements 12.3, 12.4
// ---------------------------------------------------------------------------

describe('color placement with color on', () => {
  const OPENS: readonly string[] = [...WRAPS.values()].map((wrap) => wrap.open);
  const CLOSES: readonly string[] = [...new Set([...WRAPS.values()].map((wrap) => wrap.close))];

  /** Every SGR sequence in a string, in order. */
  function sequences(text: string): readonly string[] {
    return [...text.matchAll(/\u001b\[[0-9;]*m/g)].map((match) => match[0]);
  }

  for (const { name, analysis } of CASES) {
    it(`closes every color it opens, on the line that opened it, in ${name}`, () => {
      const text = textOf(analysis, 'on');
      let opened = 0;

      for (const line of text.split('\n')) {
        let depth = 0;
        for (const sequence of sequences(line)) {
          // Only the four palette sequences may appear. Anything else — a bold, a
          // cursor move, a bare `0m` reset — would mean an unaudited escape
          // reached the output.
          expect([...OPENS, ...CLOSES]).toContain(sequence);
          if (OPENS.includes(sequence)) {
            // Never nested: only single tokens are painted, so an inner reset
            // could not end an outer color early.
            expect(depth).toBe(0);
            depth += 1;
            opened += 1;
          } else {
            expect(depth).toBe(1);
            depth -= 1;
          }
        }
        // No color survives to the next line, so nothing bleeds into a heading.
        expect(depth).toBe(0);
      }

      expect(opened).toBeGreaterThan(0);
    });
  }

  /**
   * The two modes carry the same information.
   *
   * Take the color-on output, replace each painted span by exactly what
   * Requirement 12.6 says stands in for that color, and the color-off output is
   * what comes out — byte for byte, over real recorded data. That is a stronger
   * claim than "both modes render" and it is what makes color a presentation
   * choice rather than a second code path: a token that were painted in one mode
   * and dropped in the other would fail here, and so would a marker printed in
   * both.
   */
  const SUBSTITUTE: { readonly [K in ColorCategory]: (body: string) => string } = {
    instructionType: (body) => body,
    accountRole: (body) => body.toUpperCase(),
    errorMessage: (body) => `${ERROR_MARKER} ${body}`,
    failingInstruction: (body) => `${FAIL_MARKER} ${body}`,
  };

  for (const { name, analysis } of CASES) {
    it(`yields the color-off output when its colors are substituted, in ${name}`, () => {
      let text = textOf(analysis, 'on');

      for (const category of COLOR_CATEGORIES) {
        const wrap = WRAPS.get(category);
        expect(wrap).toBeDefined();
        if (wrap === undefined) return;
        // Non-greedy, and `.` excludes the newline, so a span cannot swallow a
        // following span or cross a line.
        text = text.replace(
          new RegExp(`${quoteRegex(wrap.open)}(.*?)${quoteRegex(wrap.close)}`, 'g'),
          (_whole, body: string) => SUBSTITUTE[category](body),
        );
      }

      expect(text).not.toContain(ESC);
      expect(text).toBe(textOf(analysis, 'off'));
    });
  }
});

// ---------------------------------------------------------------------------
// Marker exclusivity — Requirements 12.6, 12.9
// ---------------------------------------------------------------------------

describe('marker exclusivity', () => {
  for (const { name, analysis } of CASES) {
    it(`emits no text marker with color on for ${name}`, () => {
      const text = textOf(analysis, 'on');

      // The markers are the substitute for color, not an addition to it.
      expect(text).not.toContain(FAIL_MARKER);
      expect(text).not.toContain(ERROR_MARKER);
      for (const label of ['WRITABLE', 'READONLY', 'UNRESOLVED']) {
        expect(text).not.toContain(label);
      }
    });

    it(`emits no ANSI sequence with color off for ${name}`, () => {
      const text = textOf(analysis, 'off');

      expect(text).not.toContain(ESC);
      expect(/\u001b\[/.test(text)).toBe(false);
    });
  }

  it('states both markers on the same output when color is off', () => {
    // Not vacuous: the synthetic case really does carry a failure and an error,
    // so the two `not.toContain` assertions above have something to exclude.
    const text = textOf(layoutAnalysis(), 'off');

    expect(text).toContain(FAIL_MARKER);
    expect(text).toContain(ERROR_MARKER);
    expect(text).toContain('WRITABLE SIGNER');
  });
});
