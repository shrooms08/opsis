/**
 * Unit tests for the terminal renderer. Requirements 12.1–12.9, and the
 * `decimal.ts` boundary at 12.5 and 12.11–12.14.
 *
 * Four kinds of assertion, kept apart on purpose.
 *
 * - **Structural, against the emitted text with color off.** Section presence,
 *   blank-line separation, and two-space-per-level indentation are properties of
 *   the string, so they are asserted on it. Color off is the mode where the text
 *   carries everything, which is exactly why those assertions belong there.
 * - **Against the palette, with color on.** Requirement 12.4's pairwise
 *   distinctness is a claim about four colors, so it is checked by enumerating
 *   `COLOR_CATEGORIES` rather than by reading four call sites and trusting them.
 * - **Table-driven, for the Requirement 12.8 decision.** `decideColorMode` takes
 *   its whole input as a parameter, so the table is the specification restated:
 *   no global is set, nothing is restored, and the precedence order is visible as
 *   rows rather than as nesting.
 * - **Through the real pipeline, over all six recorded fixtures.** Nothing is
 *   mocked; `analyzeTransaction` is the same entry point the CLI calls. That is
 *   the shape the renderer actually has to handle, and it is where a malformed
 *   assumption about a variant that no synthetic sample happens to contain would
 *   surface.
 *
 * **Recorded deviation: the `LOGS` section is a fourth section and Requirement
 * 12.1 fixes three.** It was added on an explicit user request, printing
 * Requirement 21.1's verbatim array that the renderer previously reduced to a line
 * count. The structural assertions below therefore derive the section count and
 * the heading order from `SECTION_TITLES` rather than writing down a number, so
 * the next section added does not send anyone back here. The `LOGS` heading
 * carries the collection's confidence marker, which is why the heading assertions
 * strip a trailing marker before comparing.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createIdlDecoder } from '../../src/decode/idl/idlDecoder.js';
import { loadIdlDirectory, type LoadedIdl } from '../../src/decode/idl/idlStore.js';
import type {
  AccountRef,
  Analysis,
  InstructionNode,
  LogReport,
  TokenAmount,
} from '../../src/model/analysis.js';
import type { RawTransactionResponse } from '../../src/model/rawResponse.js';
import { analyzeTransaction } from '../../src/pipeline.js';
import {
  BLANK_LOG_LINE_MARKER,
  CATEGORY_COLORS,
  COLOR_CATEGORIES,
  createPalette,
  decideColorMode,
  EMPTY_LOG_LINE_MARKER,
  EMPTY_NAME_MARKER,
  ERROR_MARKER,
  FAIL_MARKER,
  SECTION_TITLES,
  UNNAMED_MARKER,
  renderText,
  type ColorMode,
} from '../../src/render/text.js';
import { asTransactionResponse } from '../../src/source/index.js';
import { goldenCases } from '../source/support/golden.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESC = '\u001b';

/** The rendered text, or a failed assertion naming the diagnostic. */
function textOf(analysis: Analysis, mode: ColorMode = 'off'): string {
  const rendered = renderText(analysis, mode);
  if (!rendered.ok) throw new Error(`expected a successful render: ${rendered.failure.message}`);
  return rendered.text;
}

function responseOf(document: unknown): RawTransactionResponse {
  const checked = asTransactionResponse(document);
  if (!checked.ok) throw new Error(`recorded fixture is not a response: ${checked.detail}`);
  return checked.response;
}

function analysisOf(document: unknown): Analysis {
  return analyzeTransaction({ response: responseOf(document) });
}

/**
 * Instruction-tree lines, as `[indentWidth, order]`.
 *
 * Keyed on the `decode [` token, which appears on every instruction header and
 * on no other line. Matching a leading `#` alone would also catch the account
 * rows nested under an instruction, which are not tree levels.
 */
function treeLines(text: string): readonly (readonly [number, number])[] {
  return text
    .split('\n')
    .map((line) => /^( *)(?:\[FAIL\] )?#(\d+) .* {2}decode \[/.exec(stripAnsi(line)))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [(match[1] as string).length, Number(match[2])] as const);
}

/** The section headings in the order the renderer emits them. */
const SECTION_ORDER: readonly string[] = Object.values(SECTION_TITLES);

/** A container confidence marker at the end of a heading, which `LOGS` carries. */
const HEADING_MARKER = / {2}\[(?:full|partial|raw)\]$/;

/**
 * Each section's heading, with a container marker stripped.
 *
 * Stripped rather than matched loosely, so a heading that carried anything else
 * after its title would still fail the comparison.
 */
function headingsOf(text: string): readonly string[] {
  return text
    .split('\n\n')
    .map((section) => stripAnsi(section.split('\n')[0] ?? ''))
    .map((heading) => heading.replace(HEADING_MARKER, ''));
}

/** The body lines of the section with the given title, indent removed. */
function sectionBody(text: string, title: string): readonly string[] {
  const section = text
    .split('\n\n')
    .find((candidate) => stripAnsi(candidate).split('\n')[0]?.startsWith(title) === true);
  if (section === undefined) throw new Error(`no ${title} section in the output`);
  return section
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^ {2}/, ''));
}

const NON_TTY = { env: {}, isTty: false } as const;

/** SGR sequences removed, so a structural assertion can run in either mode. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// A synthetic Analysis with the variants a recorded fixture does not reach
// ---------------------------------------------------------------------------

/**
 * One `Analysis` carrying a nested CPI, a failing instruction, a resolved error,
 * a lookup-table account, an unresolved account ref, a `partial` decode, a
 * `post-only` lamport balance, and a token balance whose delta has unknown
 * `decimals`.
 *
 * Typed as `Analysis`, so the compiler keeps it in step with the model. Several
 * of those variants are unpinned by any recorded fixture — the `partial` decode
 * most notably, which tasks.md records as a v1 coverage gap — so this is where
 * they are exercised.
 */
function sampleAnalysis(): Analysis {
  const mint = 'Mint1111111111111111111111111111111111111111';
  const scaled: TokenAmount = { mint, raw: '1234567890', decimals: { known: true, value: 6 } };
  const unscaled: TokenAmount = { mint, raw: '1234567890', decimals: { known: false } };

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
        programId: 'Prog1111111111111111111111111111111111111111',
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
        referencedBy: [0, 1],
        name: 'authority',
        confidence: 'full',
      },
      {
        index: 1,
        address: 'Acct2222222222222222222222222222222222222222',
        signer: false,
        role: 'readonly',
        origin: { kind: 'lookup-table', loadedFrom: 'readonly' },
        referencedBy: [],
        // An ANSI sequence in chain-derived data. Escaped, never passed through.
        name: `${ESC}[31mspoofed${ESC}[0m`,
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
            { name: 'lamports', value: { type: 'lamports', value: '1000000000' } },
            { name: 'amount', value: { type: 'tokenAmount', value: unscaled } },
            { name: 'big', value: { type: 'u64', value: '18446744073709551615' } },
            { name: 'flag', value: { type: 'bool', value: true } },
            { name: 'memo', value: { type: 'string', value: 'hi' } },
            { name: 'rate', value: { type: 'unsupported', idlType: 'f64' } },
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
          { kind: 'unresolved', index: 9, reason: 'index 9 exceeds the key list', confidence: 'raw' },
        ],
        failed: true,
        valid: true,
        invalidReason: null,
        computeUnits: { available: true, value: 1234567, confidence: 'full' },
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
              decodedFields: [{ name: 'amount', value: { type: 'tokenAmount', value: scaled } }],
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
        programId: 'Prog1111111111111111111111111111111111111111',
        confidence: 'full',
      },
      cpiAttribution: null,
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
// Sections — Requirement 12.1
// ---------------------------------------------------------------------------

describe('sections', () => {
  it('emits every labelled section, in order, separated by one blank line', () => {
    const text = textOf(sampleAnalysis());
    const sections = text.split('\n\n');

    // Derived, not written down: one section per entry of `SECTION_TITLES`, in the
    // order that object declares, which is the order the renderer emits.
    expect(sections).toHaveLength(SECTION_ORDER.length);
    expect(headingsOf(text)).toEqual(SECTION_ORDER);
    // And the position the request fixes: logs after the tree, accounts last.
    expect(SECTION_ORDER).toEqual([
      SECTION_TITLES.metadata,
      SECTION_TITLES.instructions,
      SECTION_TITLES.logs,
      SECTION_TITLES.accounts,
    ]);
  });

  it('emits no empty line inside a section, so the separation is unambiguous', () => {
    const text = textOf(sampleAnalysis());

    // One blank-line separator per gap between sections, and none of them tripled.
    expect(text.split('\n').filter((line) => line === '')).toHaveLength(
      SECTION_ORDER.length - 1,
    );
    expect(text).not.toContain('\n\n\n');
    expect(text.startsWith('\n')).toBe(false);
    expect(text.endsWith('\n')).toBe(false);
  });

  it('puts the signature, version, outcome, and compute units in the metadata section', () => {
    const metadata = textOf(sampleAnalysis()).split('\n\n')[0] as string;

    expect(metadata).toContain('Sig11111111111111111111111111111111111111111');
    expect(metadata).toContain('v0');
    expect(metadata).toContain('failed');
    // Compute units are integers with thousand separators (Req 12.5).
    expect(metadata).toContain('9,999');
  });

  it('renders the same bytes on two calls with the same arguments', () => {
    expect(textOf(sampleAnalysis())).toBe(textOf(sampleAnalysis()));
    expect(textOf(sampleAnalysis(), 'on')).toBe(textOf(sampleAnalysis(), 'on'));
  });

  it('does not mutate the Analysis it renders', () => {
    const analysis = sampleAnalysis();
    const before = JSON.stringify(analysis);

    textOf(analysis, 'on');
    textOf(analysis, 'off');

    expect(JSON.stringify(analysis)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The LOGS section — Requirement 21.1, printed on user request
// ---------------------------------------------------------------------------

/**
 * The captured log lines, on screen.
 *
 * A fourth section where Requirement 12.1 fixes three — the deviation recorded in
 * the module header of this file and of `render/text.ts`. What is pinned here is
 * placement, order, the container marker on the heading, the three degraded
 * states told apart, and the escaping, which matters more here than anywhere else
 * in the output: a log message is program-controlled bytes and it is the one
 * string long enough and free-form enough to hide an injection in.
 */
describe('the LOGS section', () => {
  /** The sample with its log report replaced. */
  function withLogs(logs: LogReport): Analysis {
    return { ...sampleAnalysis(), logs };
  }

  const PLAIN: LogReport = {
    messages: [
      'Program 11111111111111111111111111111111 invoke [1]',
      'Program log: Instruction: Transfer',
      'Program 11111111111111111111111111111111 success',
    ],
    present: true,
    truncated: false,
    unattributed: [],
    confidence: 'full',
  };

  it('sits immediately after INSTRUCTIONS and before ACCOUNTS', () => {
    const headings = headingsOf(textOf(withLogs(PLAIN)));

    expect(headings.indexOf(SECTION_TITLES.logs)).toBe(
      headings.indexOf(SECTION_TITLES.instructions) + 1,
    );
    expect(headings.indexOf(SECTION_TITLES.accounts)).toBe(
      headings.indexOf(SECTION_TITLES.logs) + 1,
    );
  });

  it('prints every message in RPC order, one line each, and nothing else', () => {
    const body = sectionBody(textOf(withLogs(PLAIN)), SECTION_TITLES.logs);

    // Un-indented, the body is the array: same lines, same order, same count. No
    // sorting, no grouping, no deduplication, no renumbering.
    expect(body).toEqual([...PLAIN.messages]);
  });

  it('keeps a duplicated message rather than collapsing it', () => {
    const repeated = 'Program log: Instruction: Transfer';
    const body = sectionBody(
      textOf(withLogs({ ...PLAIN, messages: [repeated, repeated] })),
      SECTION_TITLES.logs,
    );

    expect(body).toEqual([repeated, repeated]);
  });

  it('indents every line and preserves whitespace the message begins with', () => {
    const inner = '    Program log: nested by the runtime';
    const text = textOf(withLogs({ ...PLAIN, messages: [inner] }));
    const line = text.split('\n').find((candidate) => candidate.includes('nested by'));

    // Two spaces of section indent, then the message's own four, untouched.
    expect(line).toBe(`  ${inner}`);
  });

  for (const confidence of ['full', 'partial', 'raw'] as const) {
    it(`carries the container marker [${confidence}] on the heading, not on the lines`, () => {
      const text = textOf(withLogs({ ...PLAIN, confidence }));
      const section = text
        .split('\n\n')
        .find((candidate) => candidate.startsWith(SECTION_TITLES.logs));
      expect(section).toBeDefined();
      if (section === undefined) return;

      expect(section.split('\n')[0]).toBe(`${SECTION_TITLES.logs}  [${confidence}]`);
      // The collection carries the marker; a verbatim line makes no claim.
      for (const line of section.split('\n').slice(1)) {
        expect(line).not.toMatch(/\[(?:full|partial|raw)\]/);
      }
    });
  }

  it('escapes a control character instead of letting it reach the terminal', () => {
    // Three attacks in one message: a forged color, a fabricated line, an erased
    // one. All of them are one line of visible `\xNN` text on the way out.
    const hostile = `Program log: ${ESC}[31m[ERROR] forged${ESC}[0m\nProgram log: fabricated\rerased`;
    const body = sectionBody(
      textOf(withLogs({ ...PLAIN, messages: [hostile] })),
      SECTION_TITLES.logs,
    );

    expect(body).toHaveLength(1);
    const line = body[0] ?? '';
    expect(line).not.toContain(ESC);
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    expect(line).toContain('\\x1b[31m');
    expect(line).toContain('\\x0a');
    expect(line).toContain('\\x0d');
    // And the whole message is still legible, byte for byte, as text.
    expect(line).toBe(
      'Program log: \\x1b[31m[ERROR] forged\\x1b[0m\\x0aProgram log: fabricated\\x0derased',
    );
  });

  it('marks an empty message rather than emitting a line that is not there', () => {
    const text = textOf(withLogs({ ...PLAIN, messages: ['first', '', 'third'] }));
    const body = sectionBody(text, SECTION_TITLES.logs);

    // The line stays present and countable, and it is not a blank line — which
    // would split the section in two — nor whitespace, which would be invisible.
    expect(body).toEqual(['first', EMPTY_LOG_LINE_MARKER, 'third']);
    expect(text.split('\n').filter((line) => line.trim() === '')).toHaveLength(
      SECTION_ORDER.length - 1,
    );
  });

  it('marks a whitespace-only message and states its length', () => {
    const body = sectionBody(
      textOf(withLogs({ ...PLAIN, messages: ['   '] })),
      SECTION_TITLES.logs,
    );

    // A separate fact from the empty message: there is content, it is invisible.
    expect(body).toEqual([`${BLANK_LOG_LINE_MARKER}  3 characters`]);
  });

  it('says the log was recorded and empty when present is true and messages are none', () => {
    const body = sectionBody(
      textOf(withLogs({ ...PLAIN, messages: [] })),
      SECTION_TITLES.logs,
    );

    expect(body).toHaveLength(1);
    expect(body[0]).toContain('recorded and held no line');
  });

  it('says no log output was recorded when the field was absent, at raw', () => {
    const text = textOf(
      withLogs({ messages: [], present: false, truncated: false, unattributed: [], confidence: 'raw' }),
    );
    const body = sectionBody(text, SECTION_TITLES.logs);

    // The section appears rather than vanishing: an absent record and an empty one
    // are different facts, and a missing section would state neither.
    expect(headingsOf(text)).toContain(SECTION_TITLES.logs);
    expect(body).toHaveLength(1);
    expect(body[0]).toContain('no log output was recorded');
    // And the two empty states do not render alike.
    expect(body).not.toEqual(
      sectionBody(textOf(withLogs({ ...PLAIN, messages: [] })), SECTION_TITLES.logs),
    );
  });

  it('prints every recorded line of a truncated log and marks the collection partial', () => {
    const text = textOf(withLogs({ ...PLAIN, truncated: true, confidence: 'partial' }));
    const body = sectionBody(text, SECTION_TITLES.logs);

    expect(body).toEqual([...PLAIN.messages]);
    expect(text.split('\n')[0]).toBe(SECTION_TITLES.metadata);
    expect(headingsOf(text)).toContain(SECTION_TITLES.logs);
    expect(text).toContain(`${SECTION_TITLES.logs}  [partial]`);
    // The truncation itself stays on the TRANSACTION row, which is where the line
    // count and the unattributed count are.
    const metadata = text.split('\n\n')[0] ?? '';
    expect(metadata).toContain('(truncated)');
  });

  it('keeps the TRANSACTION summary row, which the section does not restate', () => {
    const text = textOf(withLogs(PLAIN));
    const metadata = text.split('\n\n')[0] ?? '';

    expect(metadata).toContain('3 lines');
  });

  for (const recorded of goldenCases()) {
    it(`prints the recorded log lines of ${recorded.name} verbatim and in order`, () => {
      const analysis = analysisOf(recorded.document);
      const body = sectionBody(textOf(analysis), SECTION_TITLES.logs);

      // Real chain data, not a synthetic string: every recorded line, in the order
      // the RPC gave them.
      expect(analysis.logs.messages.length).toBeGreaterThan(0);
      expect(body).toEqual([...analysis.logs.messages]);

      // Pinned against one real line, so the section cannot pass by being empty.
      const first = analysis.logs.messages[0] ?? '';
      expect(first).toContain('invoke [1]');
      expect(textOf(analysis)).toContain(`\n  ${first}\n`);
    });
  }
});

// ---------------------------------------------------------------------------
// Indentation — Requirement 12.2
// ---------------------------------------------------------------------------

describe('tree indentation', () => {
  it('indents each tree level by exactly two more spaces than its parent', () => {
    const lines = treeLines(textOf(sampleAnalysis()));

    // depth 0, 1, 2 in the sample, in appearance order.
    expect(lines).toEqual([
      [2, 0],
      [4, 1],
      [6, 2],
    ]);
  });

  it('indents a nested CPI two spaces deeper than its parent on a recorded fixture', () => {
    const recorded = goldenCases().find((entry) => entry.name === '06-nested-cpi-failure');
    expect(recorded).toBeDefined();
    if (recorded === undefined) return;
    const analysis = analysisOf(recorded.document);

    const lines = treeLines(textOf(analysis));
    // Every top-level node sits at 2, and the fixture really does nest.
    expect(lines.filter(([width]) => width === 2).length).toBe(analysis.instructions.length);
    expect(lines.some(([width]) => width === 4)).toBe(true);
    // Every observed width is 2 + 2 * depth, i.e. an even width with no gaps.
    const widths = [...new Set(lines.map(([width]) => width))].sort((a, b) => a - b);
    expect(widths).toEqual(widths.map((_, index) => 2 + 2 * index));
  });
});

// ---------------------------------------------------------------------------
// Text markers — Requirements 12.3, 12.6, 12.9
// ---------------------------------------------------------------------------

describe('text markers with color off', () => {
  it(`prefixes exactly the failing instruction with ${FAIL_MARKER}`, () => {
    const text = textOf(sampleAnalysis());

    const marked = text.split('\n').filter((line) => line.includes(FAIL_MARKER));
    expect(marked).toHaveLength(1);
    expect(marked[0]?.trimStart().startsWith(`${FAIL_MARKER} #0 `)).toBe(true);
  });

  it('emits no marker at all when nothing failed', () => {
    const analysis = sampleAnalysis();
    const top = analysis.instructions[0];
    expect(top).toBeDefined();
    if (top === undefined) return;
    const succeeded: Analysis = {
      ...analysis,
      outcome: { succeeded: true, error: null },
      failure: null,
      instructions: [{ ...top, failed: false }],
    };

    const text = textOf(succeeded);

    expect(text).not.toContain(FAIL_MARKER);
    expect(text).not.toContain(ERROR_MARKER);
    expect(text).toContain('succeeded');
  });

  it(`prefixes a resolved error with ${ERROR_MARKER} and names code, name, and namespace`, () => {
    const text = textOf(sampleAnalysis());

    const line = text.split('\n').find((entry) => entry.includes(ERROR_MARKER));
    expect(line).toBeDefined();
    expect(line).toContain('6001');
    expect(line).toContain('SlippageExceeded');
    expect(line).toContain('anchor-user');
    expect(line).toContain('the price moved');
  });

  it('uppercases account role labels', () => {
    const text = textOf(sampleAnalysis());

    expect(text).toContain('WRITABLE SIGNER');
    expect(text).toContain('READONLY');
    // The unresolved-ref label follows the same rule, being a role position.
    expect(text).toContain('UNRESOLVED');
    // Never the lowercase spelling, which is the color-on form.
    expect(text).not.toContain('writable signer');
    expect(text).not.toMatch(/ readonly {2}/);
  });

  it('contains no ESC byte, even when the Analysis carries ANSI sequences', () => {
    const analysis = sampleAnalysis();
    // Not a vacuous check: the input really does contain escape sequences.
    expect(analysis.accountKeys[1]?.name).toContain(ESC);

    const text = textOf(analysis);

    expect(text).not.toContain(ESC);
    // Escaped as text, so the byte cannot reach the terminal and the data is
    // still legible.
    expect(text).toContain('\\x1b[31mspoofed');
  });
});

// ---------------------------------------------------------------------------
// Colors — Requirements 12.3, 12.4
// ---------------------------------------------------------------------------

describe('the palette with color on', () => {
  it('assigns four pairwise distinct colors to the four categories', () => {
    const palette = createPalette('on');
    const probe = 'x';

    const painted = COLOR_CATEGORIES.map((category) => palette[category](probe));

    expect(painted).toHaveLength(4);
    expect(new Set(painted).size).toBe(4);
    for (const text of painted) {
      // Each really is a color, not the identity.
      expect(text).toContain(ESC);
      expect(text).not.toBe(probe);
    }
    // The names are distinct too, which is the claim the record makes.
    expect(new Set(Object.values(CATEGORY_COLORS)).size).toBe(4);
  });

  it('paints the failing instruction so it differs from a non-failing one', () => {
    const text = textOf(sampleAnalysis(), 'on');

    const lines = text.split('\n');
    const failing = lines.find((line) => stripAnsi(line).includes('#0 System Program'));
    const passing = lines.find((line) => stripAnsi(line).includes('#1 Prog2222'));
    expect(failing).toBeDefined();
    expect(passing).toBeDefined();

    const failingColor = createPalette('on').failingInstruction('#0');
    expect(failing).toContain(failingColor);
    expect(passing).not.toContain(failingColor);
    // The prefix marker is the color-off substitute and is not doubled up here.
    expect(text).not.toContain(FAIL_MARKER);
  });

  it('paints the error message rather than prefixing it', () => {
    const text = textOf(sampleAnalysis(), 'on');

    const painted = createPalette('on').errorMessage(
      '6001 SlippageExceeded (anchor-user): the price moved  attested by anchor-error-log',
    );

    expect(text).not.toContain(ERROR_MARKER);
    expect(text).toContain(painted);
    // The error color is not the failing-instruction color (Req 12.4).
    expect(painted).not.toContain(createPalette('on').failingInstruction('#0').slice(0, 5));
  });

  it('is the identity in every category with color off', () => {
    const palette = createPalette('off');

    for (const category of COLOR_CATEGORIES) {
      expect(palette[category]('x')).toBe('x');
    }
  });
});

// ---------------------------------------------------------------------------
// The color decision — Requirement 12.8
// ---------------------------------------------------------------------------

describe('decideColorMode', () => {
  const cases: readonly (readonly [
    label: string,
    env: Readonly<Record<string, string | undefined>>,
    isTty: boolean,
    expected: ColorMode,
  ])[] = [
    // NO_COLOR outranks everything, including a color-capable TTY.
    ['NO_COLOR set outranks a color TTY', { NO_COLOR: '1', COLORTERM: 'truecolor', TERM: 'xterm-256color' }, true, 'off'],
    ['NO_COLOR empty still counts as set', { NO_COLOR: '', TERM: 'xterm-256color' }, true, 'off'],
    ['NO_COLOR set on a non-TTY', { NO_COLOR: '1' }, false, 'off'],

    // Not a TTY outranks every positive signal.
    ['a pipe with COLORTERM', { COLORTERM: 'truecolor' }, false, 'off'],
    ['a pipe with a color TERM', { TERM: 'xterm-256color' }, false, 'off'],
    ['a pipe with nothing set', {}, false, 'off'],

    // COLORTERM, on a TTY.
    ['COLORTERM=truecolor', { COLORTERM: 'truecolor' }, true, 'on'],
    ['COLORTERM with a dumb TERM', { COLORTERM: '24bit', TERM: 'dumb' }, true, 'on'],
    ['COLORTERM empty is not a claim', { COLORTERM: '' }, true, 'off'],
    ['COLORTERM empty falls through to TERM', { COLORTERM: '', TERM: 'xterm-256color' }, true, 'on'],

    // TERM, on a TTY with no COLORTERM.
    ['TERM=xterm-256color', { TERM: 'xterm-256color' }, true, 'on'],
    ['TERM=xterm', { TERM: 'xterm' }, true, 'on'],
    ['TERM=screen.xterm-256color', { TERM: 'screen.xterm-256color' }, true, 'on'],
    ['TERM=xterm-kitty', { TERM: 'xterm-kitty' }, true, 'on'],
    ['TERM=alacritty', { TERM: 'alacritty' }, true, 'on'],
    ['TERM=rxvt-unicode-256color', { TERM: 'rxvt-unicode-256color' }, true, 'on'],
    ['TERM=linux', { TERM: 'linux' }, true, 'on'],
    ['TERM=vt100-am (mono, unlisted)', { TERM: 'vt100-am' }, true, 'off'],
    ['TERM=dumb', { TERM: 'dumb' }, true, 'off'],
    ['TERM=DUMB, case-insensitively', { TERM: 'DUMB' }, true, 'off'],
    ['TERM empty', { TERM: '' }, true, 'off'],
    ['TERM absent', {}, true, 'off'],
    ['TERM=something-color', { TERM: 'something-color' }, true, 'on'],
    ['TERM=XTERM-256COLOR, uppercased', { TERM: 'XTERM-256COLOR' }, true, 'on'],
  ];

  for (const [label, env, isTty, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      expect(decideColorMode({ env, isTty })).toBe(expected);
    });
  }

  it('reads no global: the decision depends only on its argument', () => {
    // `process.env` on a CI machine may or may not have TERM set; neither can
    // change these two answers.
    expect(decideColorMode(NON_TTY)).toBe('off');
    expect(decideColorMode({ env: { COLORTERM: '1' }, isTty: true })).toBe('on');
  });
});

// ---------------------------------------------------------------------------
// Numbers — Requirements 12.5, 12.11, 12.13, 12.14
// ---------------------------------------------------------------------------

describe('numeric formatting', () => {
  it('renders a lamport amount as SOL with exactly nine fractional digits', () => {
    const text = textOf(sampleAnalysis());

    // A decoded lamports field of exactly 1 SOL.
    expect(text).toContain('1.000000000 SOL');
    // A u64::MAX balance, exact, with separators on the integer portion, which no
    // float could produce.
    expect(text).toContain('18,446,744,073.709551615 SOL');
    // A negative delta keeps its sign and its nine digits.
    expect(text).toContain('-0.000005000 SOL');
    // Every SOL value on screen has exactly nine fractional digits.
    const fractions = [...text.matchAll(/[\d,]+\.(\d+) SOL/g)].map((match) => match[1]);
    expect(fractions.length).toBeGreaterThan(0);
    for (const fraction of fractions) {
      expect(fraction).toHaveLength(9);
    }
  });

  it('renders a token amount at its mint scale, without the nine-digit lamport rule', () => {
    const text = textOf(sampleAnalysis());

    // decimals 6 on raw 1234567890.
    expect(text).toContain('1,234.567890');
    expect(text).not.toContain('1.234567890');
  });

  it('renders a token amount with unknown decimals as labelled base units at partial confidence', () => {
    const text = textOf(sampleAnalysis());

    const line = text.split('\n').find((entry) => entry.includes('base units'));
    expect(line).toBeDefined();
    // The raw integer verbatim: no decimal point, no separators, no guessed scale.
    expect(line).toContain('1234567890 base units [partial]');
    // Not silently scaled by 6, by 9, or by anything else.
    expect(line).not.toContain('1,234.567890');
    expect(line).not.toContain('1.234567890');
  });

  it('formats compute units as integers with thousand separators', () => {
    const text = textOf(sampleAnalysis());

    expect(text).toContain('1,234,567');
    expect(text).toContain('9,999');
  });

  it('renders a post-only lamport balance without inventing a delta', () => {
    const text = textOf(sampleAnalysis());

    const line = text.split('\n').find((entry) => entry.includes('delta not recorded'));
    expect(line).toBeDefined();
    expect(line).toContain('post 0.000000001 SOL');
  });
});

// ---------------------------------------------------------------------------
// Confidence markers — honest degradation
// ---------------------------------------------------------------------------

describe('confidence markers', () => {
  it('shows a marker for every element that carries one, including full', () => {
    const text = textOf(sampleAnalysis());

    expect(text).toContain('[full]');
    expect(text).toContain('[partial]');
    expect(text).toContain('[raw]');
    // Each instruction header states its own decode marker and the propagated
    // subtree marker, which can differ.
    expect(text).toContain('decode [full]  subtree [raw]');
    expect(text).toContain('decode [partial]  subtree [raw]');
    expect(text).toContain('decode [raw]  subtree [raw]');
  });

  it('shows the raw payload and the reason a decode failed', () => {
    const text = textOf(sampleAnalysis());

    expect(text).toContain('0xdeadbeef');
    expect(text).toContain('0x00');
    expect(text).toContain('no decoder is registered');
    expect(text).toContain('Unknown program');
    expect(text).toContain('program index 7 is out of range');
  });

  it('names an unsupported IDL type instead of printing a value for it', () => {
    const text = textOf(sampleAnalysis());

    expect(text).toContain('unsupported IDL type f64');
  });
});

// ---------------------------------------------------------------------------
// Name markers — no data-derived name renders as a blank
// ---------------------------------------------------------------------------

/**
 * Every name the renderer reads off the `Analysis` carries a visible token, and
 * the two absences are told apart.
 *
 * `<unnamed>` is Requirement 7.13's absence: an instruction with no applicable
 * IDL entry keeps every `AccountRef.name` `null` while every address stays
 * exactly as it was, so nothing failed and the word "unresolved" — which
 * `instructionHeader` uses for a program index that could not be resolved to an
 * address — would overstate it. `<empty name>` is the other fact: an artifact
 * supplied a name and it was zero characters long.
 *
 * The reachability of the second is demonstrated rather than assumed, below,
 * because it decides whether the instruction-header marker is real coverage or
 * dead code.
 */
describe('name markers', () => {
  /** The sample with the first resolved account ref of instruction #0 renamed. */
  function withRefNamed(name: string | null): Analysis {
    const analysis = sampleAnalysis();
    const top = analysis.instructions[0];
    if (top === undefined) throw new Error('the sample no longer carries an instruction');
    const [first, ...rest] = top.accounts;
    if (first === undefined || first.kind !== 'resolved') {
      throw new Error('the sample no longer opens with a resolved account ref');
    }
    const renamed: AccountRef = { ...first, name };
    return { ...analysis, instructions: [{ ...top, accounts: [renamed, ...rest] }] };
  }

  /** The sample with instruction #0's decoded name replaced. */
  function withDecodeNamed(name: string): Analysis {
    const analysis = sampleAnalysis();
    const top = analysis.instructions[0];
    if (top === undefined || top.decode.kind !== 'full') {
      throw new Error('the sample no longer opens with a full decode');
    }
    return {
      ...analysis,
      instructions: [{ ...top, decode: { ...top.decode, name } }],
    };
  }

  /** The sample with instruction #0 carrying exactly one decoded field. */
  function withFieldNamed(name: string): Analysis {
    const analysis = sampleAnalysis();
    const top = analysis.instructions[0];
    if (top === undefined || top.decode.kind !== 'full') {
      throw new Error('the sample no longer opens with a full decode');
    }
    return {
      ...analysis,
      instructions: [
        {
          ...top,
          decode: { ...top.decode, fields: [{ name, value: { type: 'bool', value: true } }] },
          inner: [],
        },
      ],
    };
  }

  /**
   * Account ref #0 of instruction #0, whole.
   *
   * The role is a parameter because it is the one token that legitimately differs
   * between the modes — uppercase stands in for the color (Req 12.6) — so a
   * stripped color-on row is compared against the lowercase spelling.
   */
  function row(role: string, name: string): string {
    return `      #0 ${role}  Acct1111111111111111111111111111111111111111  ${name}  [full]`;
  }

  it('marks an account the IDL could not name instead of ending the row early', () => {
    const text = textOf(withRefNamed(null));

    // The whole row, so the name column is pinned as present and the gaps as two
    // spaces — the shape a blank made indistinguishable from a row that ended.
    expect(text).toContain(row('WRITABLE SIGNER', UNNAMED_MARKER));
  });

  it('marks it identically with color on, so it substitutes for no color', () => {
    const on = textOf(withRefNamed(null), 'on');

    expect(on).toContain(UNNAMED_MARKER);
    // The marker itself is never painted: strip the role color and the row is the
    // color-off row, down to the lowercase role that color mode uses.
    expect(stripAnsi(on)).toContain(row('writable signer', UNNAMED_MARKER));
    expect(on).toContain(`  ${UNNAMED_MARKER}  `);
  });

  it('leaves a name the IDL did supply exactly as it was, in both modes', () => {
    const off = textOf(withRefNamed('authority'));
    const on = textOf(withRefNamed('authority'), 'on');

    expect(off).toContain(row('WRITABLE SIGNER', 'authority'));
    expect(stripAnsi(on)).toContain(row('writable signer', 'authority'));
    // No marker is introduced where a real name exists.
    expect(off).not.toContain(UNNAMED_MARKER);
    expect(off).not.toContain(EMPTY_NAME_MARKER);
  });

  it('tells an empty name apart from an absent one', () => {
    const empty = textOf(withRefNamed(''));

    expect(empty).toContain(row('WRITABLE SIGNER', EMPTY_NAME_MARKER));
    // The two facts are different and are not collapsed onto one marker.
    expect(empty).not.toContain(UNNAMED_MARKER);
    expect(EMPTY_NAME_MARKER).not.toBe(UNNAMED_MARKER);
  });

  it('does not borrow the word the header uses for a program that would not resolve', () => {
    // `<unresolved program>` means a resolution failed, and the sample really does
    // carry one — on an instruction header, where a program index went bad.
    // Requirement 7.13's null name is not that: the address resolved and no IDL
    // named it, so the account row must not reach for the same word.
    const text = textOf(withRefNamed(null));
    expect(text).toContain('<unresolved program>');

    const accountRow = text.split('\n').find((line) => line.includes(UNNAMED_MARKER));
    expect(accountRow).toBeDefined();
    expect(accountRow).not.toContain('unresolved');
    expect(UNNAMED_MARKER).not.toContain('unresolved');
  });

  it('marks an empty decoded instruction name in the header', () => {
    const text = textOf(withDecodeNamed(''));

    expect(text).toContain(`#0 System Program  ${EMPTY_NAME_MARKER}  decode [full]`);
    // A real name is still rendered verbatim in the same position.
    expect(textOf(withDecodeNamed('transfer'))).toContain('#0 System Program  transfer  decode [full]');
  });

  it('paints the header marker with the instruction-type color, like the name it stands for', () => {
    const on = textOf(withDecodeNamed(''), 'on');

    expect(on).toContain(createPalette('on').instructionType(EMPTY_NAME_MARKER));
    // Which is still the same bytes once the color is stripped (Req 12.6/12.9).
    expect(stripAnsi(on)).toContain(`${EMPTY_NAME_MARKER}  decode [full]`);
  });

  it('marks an empty decoded field name so the label column is never blank', () => {
    const emptyLine = textOf(withFieldNamed('')).split('\n').find((line) => line.includes('true'));
    const namedLine = textOf(withFieldNamed('flag')).split('\n').find((line) => line.includes('true'));

    expect(emptyLine).toBeDefined();
    expect(namedLine).toBeDefined();
    // `<`, `>`, and a space are not regex metacharacters, so the marker is its
    // own pattern.
    expect(emptyLine).toMatch(new RegExp(`^ +${EMPTY_NAME_MARKER} +true$`));
    // Same value column as a named field: the label is marked, not shifted.
    expect(emptyLine?.indexOf('true')).toBe(namedLine?.indexOf('true'));
  });

  it('marks an empty account-entry name rather than ending the line in whitespace', () => {
    const analysis = sampleAnalysis();
    const entry = analysis.accountKeys[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const text = textOf({ ...analysis, accountKeys: [{ ...entry, name: '' }] });

    const line = text.split('\n').find((candidate) => /^ {4}name/.test(candidate));
    // The value is the marker and the line ends there: no padded-then-empty tail.
    expect(line).toMatch(new RegExp(`^ {4}name {2,}${EMPTY_NAME_MARKER}$`));
  });
});

/**
 * The empty-name case is reachable, not defensive.
 *
 * `idlStore.ts` validates `instructions[].name` with `typeof name !== 'string'`,
 * which accepts `""`, and `idlDecoder.ts` carries the value into
 * `DecodeOutcome.name` verbatim — so a loaded IDL really does produce a `full`
 * decode whose name is the empty string, which before this change rendered as
 * nothing at all in the instruction header. Nothing is mocked and nothing is
 * stubbed: the IDL is written to disk and read back through the real loader.
 *
 * Offline: one temporary directory, no network.
 */
describe('an empty IDL instruction name is reachable through the real loader', () => {
  const address = 'Prog1111111111111111111111111111111111111111';
  const discriminator = [1, 2, 3, 4, 5, 6, 7, 8];
  let directory = '';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'opsis-empty-name-'));
    await writeFile(
      join(directory, 'probe.json'),
      JSON.stringify({
        version: '0.1.0',
        name: 'probe',
        address,
        instructions: [
          {
            name: '',
            discriminator,
            accounts: [{ name: '' }],
            args: [{ name: '', type: 'u8' }],
          },
        ],
      }),
    );
  });

  afterAll(async () => {
    if (directory !== '') await rm(directory, { recursive: true, force: true });
  });

  it('loads without a warning and decodes to a full outcome whose name is empty', async () => {
    const store = await loadIdlDirectory(directory);
    expect(store.warnings).toEqual([]);

    const idl: LoadedIdl | undefined = store.get(address);
    expect(idl).toBeDefined();
    if (idl === undefined) return;
    expect(idl.instructions[0]?.name).toBe('');

    const outcome = createIdlDecoder(idl).decode(new Uint8Array([...discriminator, 42]), []);

    expect(outcome.kind).toBe('full');
    if (outcome.kind !== 'full') return;
    // An empty instruction name and an empty argument name, both from the file.
    expect(outcome.name).toBe('');
    expect(outcome.fields[0]?.name).toBe('');
  });

  it('renders both of those as markers rather than as nothing', async () => {
    const store = await loadIdlDirectory(directory);
    const idl = store.get(address);
    expect(idl).toBeDefined();
    if (idl === undefined) return;
    const outcome = createIdlDecoder(idl).decode(new Uint8Array([...discriminator, 42]), []);
    if (outcome.kind !== 'full') throw new Error('the probe IDL no longer decodes fully');

    const analysis = sampleAnalysis();
    const top = analysis.instructions[0];
    if (top === undefined) throw new Error('the sample no longer carries an instruction');
    const node: InstructionNode = {
      ...top,
      decode: {
        kind: 'full',
        name: outcome.name,
        source: 'anchor-idl',
        fields: outcome.fields,
        confidence: 'full',
      },
      inner: [],
    };

    const text = textOf({ ...analysis, instructions: [node] });

    expect(text).toContain(`${EMPTY_NAME_MARKER}  decode [full]`);
    // Twice: once for the instruction name, once for the argument name.
    expect(text.split(EMPTY_NAME_MARKER)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The failure path — Requirement 12.7
// ---------------------------------------------------------------------------

describe('rendering failure', () => {
  const malformed: readonly (readonly [string, unknown, string])[] = [
    ['an empty object', {}, 'the analysis is empty'],
    ['null', null, 'the analysis is null rather than an object'],
    ['undefined', undefined, 'the analysis is nothing rather than an object'],
    ['an array', [], 'the analysis is an array rather than an object'],
    ['a string', 'nope', 'the analysis is the string "nope" rather than an object'],
    ['a missing signature', { messageVersion: 'v0' }, 'expected a string, found nothing'],
    [
      'a bad messageVersion',
      { signature: 's', messageVersion: 'v1' },
      "expected 'legacy' or 'v0', found the string \"v1\"",
    ],
  ];

  for (const [label, value, expected] of malformed) {
    it(`reports ${label} as a rendering failure instead of throwing`, () => {
      const rendered = renderText(value as Analysis, 'off');

      expect(rendered.ok).toBe(false);
      if (rendered.ok) return;
      expect(rendered.failure.kind).toBe('text-render-failure');
      expect(rendered.failure.message).toContain('rendering failure');
      expect(rendered.failure.reason).toContain(expected);
    });
  }

  it('locates the offending field so the diagnostic is actionable', () => {
    const rendered = renderText(
      { ...sampleAnalysis(), instructions: 'not an array' } as unknown as Analysis,
      'off',
    );

    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.failure.path).toBe('/instructions');
    expect(rendered.failure.message).toContain('/instructions');
  });

  it('reports a numeric leaf that escaped the model rather than printing digits nobody can vouch for', () => {
    const analysis = sampleAnalysis();
    const balance = analysis.lamportBalances[0];
    expect(balance).toBeDefined();
    if (balance === undefined) return;
    const rendered = renderText(
      { ...analysis, lamportBalances: [{ ...balance, pre: '1.5e9' }] } as unknown as Analysis,
      'off',
    );

    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.failure.reason).toContain('decimal integer string');
  });

  it('writes nothing to stderr: the diagnostic is a value the CLI reports', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      renderText({} as Analysis, 'off');
      renderText(undefined as unknown as Analysis, 'on');
      renderText(sampleAnalysis(), 'off');

      expect(stderr).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it('carries a message ready to be a render-failure detail', () => {
    const rendered = renderText({} as Analysis, 'off');

    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    // What `cli.ts` hands to `writeDiagnostic` and puts on the outcome, unchanged.
    expect(rendered.failure.message).toBe(
      'rendering failure: the analysis is empty at the document root',
    );
  });
});

// ---------------------------------------------------------------------------
// The real pipeline over the recorded fixtures
// ---------------------------------------------------------------------------

describe('over the recorded fixtures, through the real pipeline', () => {
  for (const recorded of goldenCases()) {
    it(`renders ${recorded.name} without failure in both modes`, () => {
      const analysis = analysisOf(recorded.document);

      for (const mode of ['off', 'on'] as const) {
        const rendered = renderText(analysis, mode);
        expect(rendered.ok).toBe(true);
        if (!rendered.ok) return;

        const text = rendered.text;
        // One section per `SECTION_TITLES` entry, in that order, over real data.
        expect(text.split('\n\n')).toHaveLength(SECTION_ORDER.length);
        expect(headingsOf(text)).toEqual(SECTION_ORDER);

        expect(text).toContain(analysis.signature);
        expect(text).toContain(analysis.messageVersion);
        // One tree line per instruction at every depth.
        expect(treeLines(text)).toHaveLength(countNodes(analysis));
        // Deterministic (Req 9.1).
        expect(renderText(analysisOf(recorded.document), mode)).toStrictEqual(rendered);
      }
    });

    it(`renders ${recorded.name} with no ESC byte and the right markers with color off`, () => {
      const analysis = analysisOf(recorded.document);
      const text = textOf(analysis);

      expect(text).not.toContain(ESC);

      // `[FAIL]` marks exactly the instructions the Analysis marks as failed.
      const failed = analysis.instructions.filter((node) => node.failed);
      const marked = text.split('\n').filter((line) => line.includes(FAIL_MARKER));
      expect(marked).toHaveLength(failed.length);
      for (const node of failed) {
        expect(marked.some((line) => line.trimStart().startsWith(`${FAIL_MARKER} #${node.order} `))).toBe(true);
      }

      // `[ERROR]` appears exactly when the Analysis carries a resolved error.
      const hasError = analysis.outcome.error !== null;
      expect(text.includes(ERROR_MARKER)).toBe(hasError);

      // Every lamport balance appears as SOL with nine fractional digits, and the
      // raw integer form appears nowhere (SOL is a text-renderer concern only).
      for (const balance of analysis.lamportBalances) {
        expect(text).toContain(`post ${solOf(balance.post)}`);
      }
    });

    it(`marks every unnamed account of ${recorded.name} in both modes`, () => {
      const analysis = analysisOf(recorded.document);

      // No `--idl-dir` is in play for a recorded fixture, so Requirement 7.13
      // holds for every ref: the address resolved and no IDL supplied a name.
      const unnamed = countUnnamedRefs(analysis.instructions);
      expect(unnamed).toBeGreaterThan(0);

      for (const mode of ['off', 'on'] as const) {
        const text = textOf(analysis, mode);
        expect(text.split(UNNAMED_MARKER)).toHaveLength(unnamed + 1);
        // Nothing here supplied an empty name, so the other marker stays absent.
        expect(text).not.toContain(EMPTY_NAME_MARKER);
      }
    });
  }
});

/** Resolved refs with no IDL name, at every depth. */
function countUnnamedRefs(nodes: readonly InstructionNode[]): number {
  return nodes.reduce(
    (total, node) =>
      total +
      node.accounts.filter((ref) => ref.kind === 'resolved' && ref.name === null).length +
      countUnnamedRefs(node.inner),
    0,
  );
}

function countNodes(analysis: Analysis): number {
  const walk = (nodes: readonly Analysis['instructions'][number][]): number =>
    nodes.reduce((total, node) => total + 1 + walk(node.inner), 0);
  return walk(analysis.instructions);
}

/**
 * The SOL spelling of a lamport integer, computed with `bigint` and string
 * padding rather than by calling the module under test.
 *
 * An independent oracle: it shares no code with `decimal.ts`, so agreeing with it
 * is evidence and not a restatement.
 */
function solOf(lamports: string): string {
  const negative = lamports.startsWith('-');
  const magnitude = BigInt(negative ? lamports.slice(1) : lamports);
  const whole = (magnitude / 1000000000n).toString();
  const fraction = (magnitude % 1000000000n).toString().padStart(9, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative && magnitude !== 0n ? '-' : ''}${grouped}.${fraction} SOL`;
}
